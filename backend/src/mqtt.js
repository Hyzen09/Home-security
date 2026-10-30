import mqtt from "mqtt";
import db from "./db.js";
import { pushToUser } from "./ws.js";

const BROKER_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

// Device protocol (firmware/src/main.cpp, simulator/device-sim.js):
//   devices/{id}/commands  <- {type:"output_set", output:"green"|"yellow"|"red"|"buzzer", state}
//                             {type:"alert_mode_set", active}
//   devices/{id}/state     -> {green, yellow, red, buzzer, alarm, presence, alert_mode_active, uptime_ms} (retained)
//   devices/{id}/events    -> {type:"sensor_trigger"} on each new presence detection, {type:"heartbeat"}

export const client = mqtt.connect(BROKER_URL, {
  clientId: "cloud-backend-" + Math.random().toString(16).slice(2),
});

client.on("connect", () => {
  console.log(`[mqtt] connected to broker at ${BROKER_URL}`);
  client.subscribe("devices/+/events");
  client.subscribe("devices/+/state");
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

client.on("message", (topic, payloadBuf) => {
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

  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);

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

  if (topic.endsWith("/state")) {
    db.prepare(
      `UPDATE devices SET green_state = ?, yellow_state = ?, red_state = ?, buzzer_state = ?,
         alarm_state = ?, presence = ?, alert_mode_active = ?
       WHERE device_id = ?`
    ).run(
      bit(msg.green),
      bit(msg.yellow),
      bit(msg.red),
      bit(msg.buzzer),
      bit(msg.alarm),
      bit(msg.presence),
      bit(msg.alert_mode_active),
      deviceId
    );

    const userId = ownerOf(deviceId);
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

export function setOutput(deviceId, output, state) {
  sendCommand(deviceId, { type: "output_set", output, state });
}
