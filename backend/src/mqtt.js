import mqtt from "mqtt";
import db from "./db.js";
import { pushToUser } from "./ws.js";
import { isOnline } from "./device-view.js";
import { scheduleForDevice } from "./user-view.js";

const BROKER_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

// Device protocol (firmware/src/main.ino, simulator/device-sim.js):
//   devices/{id}/commands  <- {type:"output_set", output:"relay1"|"relay2", state}
//                             {type:"alert_mode_set", active}
//                             {type:"alarm_stop"}  (silence; stays armed)
//                             {type:"ping"}  (every 5 s; the unit answers with a heartbeat event)
//                             {type:"schedule_set", enabled, start_min, end_min, tz_offset_min}
//                               (the owner's night alarm; sent whenever the unit comes online and on change)
//                             {type:"sync"}  (the unit was removed in the app: it asks POST /provisioning/status and resets)
//   devices/{id}/state     -> {relay1, relay2, alarm, presence, alert_mode_active (the alarm switch),
//                              schedule_active (the night alarm is arming it now), uptime_ms} (retained)
//   devices/{id}/events    -> {type:"sensor_trigger"} on each new presence detection,
//                             {type:"heartbeat", rssi} (answers each ping; rssi = WiFi signal, dBm)

export const client = mqtt.connect(BROKER_URL, {
  clientId: "cloud-backend-" + Math.random().toString(16).slice(2),
});

client.on("connect", () => {
  console.log(`[mqtt] connected to broker at ${BROKER_URL}`);
  client.subscribe("devices/+/events");
  client.subscribe("devices/+/state");
  checkDevices();
});

client.on("error", (err) => console.error("[mqtt] error", err.message));

function deviceIdFromTopic(topic) {
  // devices/{id}/events  or  devices/{id}/state
  return topic.split("/")[1];
}

function ownerOf(deviceId) {
  const row = db.prepare("SELECT owner_user_id FROM devices WHERE device_id = ?").get(deviceId);
  return row?.owner_user_id || null;
}

const bit = (v) => (v ? 1 : 0);

// ---------------- Online / offline ----------------

const CHECK_INTERVAL_MS = 1_000; // how soon the app hears that a unit went quiet (after OFFLINE_AFTER_MS)
const PING_EVERY_N_CHECKS = 5; // so a ping goes out every 5 s
let checks = 0;
const lastOnline = new Map(); // device_id -> the online value the app was last told

// Tells the owner's app when a unit goes online/offline (only on a change).
function noteOnline(deviceId, online) {
  if (lastOnline.get(deviceId) === online) return;
  lastOnline.set(deviceId, online);
  // Back online (or first heard since a backend restart): make sure it has the owner's night alarm.
  if (online) sendSchedule(deviceId, scheduleForDevice(deviceId));
  const row = db.prepare("SELECT owner_user_id, last_seen FROM devices WHERE device_id = ?").get(deviceId);
  console.log(`[mqtt] ${deviceId} is ${online ? "online" : "offline"}`);
  if (row?.owner_user_id) {
    pushToUser(row.owner_user_id, { type: "device_status", device_id: deviceId, online, last_seen: row.last_seen });
  }
}

// Pings every claimed unit and marks the ones that have gone quiet offline. A
// unit answers within a second, so a plugged-in unit never ages out; one that
// is unplugged, or can't reach WiFi, stops answering.
export function checkDevices() {
  if (!client.connected) return; // our own broker link is down: say nothing about the units
  const ping = checks++ % PING_EVERY_N_CHECKS === 0;
  // Units removed in the app and still waiting to reset are pinged too, so a lost
  // "sync" nudge is repeated within seconds (their reply triggers it, see below).
  const rows = db.prepare("SELECT * FROM devices WHERE status = 'claimed' OR reset_pending = 1").all();
  for (const row of rows) {
    if (ping) sendCommand(row.device_id, { type: "ping" });
    if (row.status === "claimed") noteOnline(row.device_id, isOnline(row));
  }
}
setInterval(checkDevices, CHECK_INTERVAL_MS);

client.on("message", (topic, payloadBuf, packet) => {
  let msg;
  try {
    msg = JSON.parse(payloadBuf.toString());
  } catch {
    console.warn("[mqtt] bad JSON on", topic);
    return;
  }
  const deviceId = deviceIdFromTopic(topic);
  const device = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
  if (!device) return; // unknown or prototype-1 unit

  // The broker replays a unit's retained state on every (re)subscribe, which
  // says nothing about whether the unit is alive right now.
  if (!packet.retain) {
    db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);
    noteOnline(deviceId, true);
    // Removed in the app while it was offline (or the nudge got lost): it is talking
    // to us now, so tell it again. It answers by asking /provisioning/status.
    if (device.reset_pending && device.status !== "claimed") requestSync(deviceId);
  }

  if (topic.endsWith("/events") && msg.type === "heartbeat" && Number.isInteger(msg.rssi)) {
    noteRssi(device, msg.rssi);
  }

  if (topic.endsWith("/events") && msg.type === "sensor_trigger") {
    // The unit decides the alarm itself when armed (and its state push rings the
    // phone); the cloud's job here is logging + notification.
    const alertActive = !!device.alert_mode_active || !!device.schedule_active;
    db.prepare("INSERT INTO sensor_events (device_id, alert_mode_active) VALUES (?, ?)").run(deviceId, bit(alertActive));
    console.log(`[mqtt] sensor_trigger device=${deviceId} alert_mode_active=${alertActive}`);

    const userId = ownerOf(deviceId);
    if (userId) {
      pushToUser(userId, {
        type: "sensor_event",
        device_id: deviceId,
        alert_mode_active: alertActive,
        ts: new Date().toISOString(),
      });
    }
  }

  if (topic.endsWith("/state")) {
    db.prepare(
      `UPDATE devices SET relay1_state = ?, relay2_state = ?, alarm_state = ?, presence = ?, alert_mode_active = ?,
         schedule_active = ?
       WHERE device_id = ?`
    ).run(
      bit(msg.relay1),
      bit(msg.relay2),
      bit(msg.alarm),
      bit(msg.presence),
      bit(msg.alert_mode_active),
      bit(msg.schedule_active),
      deviceId
    );

    // A retained state replayed on (re)subscribe is only what the unit last said
    // before it went quiet; pushing it would e.g. start the phone alarm for a
    // unit that died mid-alarm. The app reads that through REST, which masks it.
    const userId = packet.retain ? null : ownerOf(deviceId);
    if (userId) {
      pushToUser(userId, {
        type: "device_state",
        device_id: deviceId,
        relay1: !!msg.relay1,
        relay2: !!msg.relay2,
        alarm: !!msg.alarm,
        presence: !!msg.presence,
        alert_mode_active: !!msg.alert_mode_active,
        schedule_active: !!msg.schedule_active,
      });
    }
  }
});

// Live WiFi signal: saved, and pushed to the owner's app when it changes. A heartbeat
// answers each 5 s ping, so the app sees the signal move as the unit is carried around.
function noteRssi(device, rssi) {
  if (device.rssi === rssi) return;
  db.prepare("UPDATE devices SET rssi = ? WHERE device_id = ?").run(rssi, device.device_id);
  if (device.owner_user_id) {
    pushToUser(device.owner_user_id, { type: "device_rssi", device_id: device.device_id, rssi });
  }
}

// Tells a unit to ask the backend (HTTP, with its device_secret) whether it was
// removed from its owner's account and must reset. It is only a nudge: the broker
// is open to anyone, so the unit acts on the backend's answer, never on this message.
// Sent at most every 10 s per unit.
const SYNC_MIN_GAP_MS = 10_000;
const lastSync = new Map(); // device_id -> when the last sync went out
export function requestSync(deviceId) {
  const now = Date.now();
  if (now - (lastSync.get(deviceId) ?? 0) < SYNC_MIN_GAP_MS) return;
  lastSync.set(deviceId, now);
  sendCommand(deviceId, { type: "sync" });
}

export function sendCommand(deviceId, command) {
  client.publish(`devices/${deviceId}/commands`, JSON.stringify(command));
}

export function setAlertMode(deviceId, active) {
  sendCommand(deviceId, { type: "alert_mode_set", active });
}

export function sendSchedule(deviceId, schedule) {
  const { enabled, start_min, end_min, tz_offset_min } = schedule;
  sendCommand(deviceId, { type: "schedule_set", enabled, start_min, end_min, tz_offset_min });
}

export function stopAlarm(deviceId) {
  sendCommand(deviceId, { type: "alarm_stop" });
}

export function setOutput(deviceId, output, state) {
  sendCommand(deviceId, { type: "output_set", output, state });
}
