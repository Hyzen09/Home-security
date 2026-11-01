import mqtt from "mqtt";
import db from "./db.js";
import { pushToUser } from "./ws.js";
import { isOnline, radarSettingsOf, toPublicDevice } from "./device-view.js";

const BROKER_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

// Device protocol (firmware/src/main.cpp, simulator/device-sim.js):
//   devices/{id}/commands  <- {type:"output_set", output:"green"|"yellow"|"red"|"buzzer", state}
//                             {type:"alert_mode_set", active}
//                             {type:"alarm_stop"}  (silence; stays armed)
//                             {type:"radar_config", max_range_units, no_person_delay_s, sensitivity, near_threshold}
//                             {type:"ping"}  (every 15 s; the unit answers with a heartbeat event)
//   devices/{id}/state     -> {green, yellow, red, buzzer, alarm, presence, alert_mode_active,
//                              radar_ok, target_cm, uptime_ms} (retained)
//   devices/{id}/events    -> {type:"sensor_trigger"} on each new presence detection, {type:"heartbeat"},
//                             {type:"radar_info", radar_ok, max_range_units, no_person_delay_s, sensitivity, near_threshold},
//                             {type:"radar_config_result", status, error?}

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

const CHECK_INTERVAL_MS = 5_000; // how soon the app hears that a unit went quiet
const PING_EVERY_N_CHECKS = 3; // so a ping goes out every 15 s
let checks = 0;
const lastOnline = new Map(); // device_id -> the online value the app was last told

// Tells the owner's app when a unit goes online/offline (only on a change).
function noteOnline(deviceId, online) {
  if (lastOnline.get(deviceId) === online) return;
  lastOnline.set(deviceId, online);
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
  const rows = db.prepare("SELECT * FROM devices WHERE status = 'claimed'").all();
  for (const row of rows) {
    if (ping) sendCommand(row.device_id, { type: "ping" });
    noteOnline(row.device_id, isOnline(row));
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
  }

  if (topic.endsWith("/events") && msg.type === "sensor_trigger") {
    // The unit already sounds its own buzzer locally when armed; the cloud's
    // job here is logging + notification.
    const alertActive = !!device.alert_mode_active;
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

  if (topic.endsWith("/events") && msg.type === "radar_info") {
    const settings = {
      ...radarSettingsOf(device),
      sensitivity: Number.isInteger(msg.sensitivity) ? msg.sensitivity : 0,
      near_threshold: Number.isInteger(msg.near_threshold) ? msg.near_threshold : 0,
    };
    if (msg.radar_ok) {
      settings.max_range_units = msg.max_range_units;
      settings.no_person_delay_s = msg.no_person_delay_s;
    }
    db.prepare("UPDATE devices SET radar_settings = ?, radar_ok = ? WHERE device_id = ?").run(
      JSON.stringify(settings),
      bit(msg.radar_ok),
      deviceId
    );
    const userId = ownerOf(deviceId);
    if (userId) {
      const row = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
      pushToUser(userId, { type: "radar_info", device_id: deviceId, radar: toPublicDevice(row).radar });
    }
  }

  if (topic.endsWith("/events") && msg.type === "radar_config_result") {
    const userId = ownerOf(deviceId);
    if (userId) {
      pushToUser(userId, { type: msg.type, device_id: deviceId, status: msg.status, error: msg.error ?? null });
    }
  }

  if (topic.endsWith("/state")) {
    const targetCm = Number.isInteger(msg.target_cm) && msg.target_cm >= 0 ? msg.target_cm : null;
    db.prepare(
      `UPDATE devices SET green_state = ?, yellow_state = ?, red_state = ?, buzzer_state = ?,
         alarm_state = ?, presence = ?, alert_mode_active = ?,
         radar_ok = ?, target_cm = ?
       WHERE device_id = ?`
    ).run(
      bit(msg.green),
      bit(msg.yellow),
      bit(msg.red),
      bit(msg.buzzer),
      bit(msg.alarm),
      bit(msg.presence),
      bit(msg.alert_mode_active),
      bit(msg.radar_ok),
      targetCm,
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
        green: !!msg.green,
        yellow: !!msg.yellow,
        red: !!msg.red,
        buzzer: !!msg.buzzer,
        alarm: !!msg.alarm,
        presence: !!msg.presence,
        alert_mode_active: !!msg.alert_mode_active,
        target_cm: targetCm,
        radar_connected: !!msg.radar_ok,
      });
    }
  }
});

export function sendCommand(deviceId, command) {
  client.publish(`devices/${deviceId}/commands`, JSON.stringify(command));
}

export function setAlertMode(deviceId, active) {
  sendCommand(deviceId, { type: "alert_mode_set", active });
}

export function setRadarConfig(deviceId, { max_range_units, no_person_delay_s, sensitivity, near_threshold }) {
  sendCommand(deviceId, { type: "radar_config", max_range_units, no_person_delay_s, sensitivity, near_threshold });
}

export function stopAlarm(deviceId) {
  sendCommand(deviceId, { type: "alarm_stop" });
}

export function setOutput(deviceId, output, state) {
  sendCommand(deviceId, { type: "output_set", output, state });
}
