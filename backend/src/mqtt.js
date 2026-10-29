import mqtt from "mqtt";
import db from "./db.js";
import { pushToUser } from "./ws.js";

const BROKER_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

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

client.on("message", (topic, payloadBuf) => {
  let msg;
  try {
    msg = JSON.parse(payloadBuf.toString());
  } catch {
    console.warn("[mqtt] bad JSON on", topic);
    return;
  }
  const deviceId = deviceIdFromTopic(topic);

  db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?").run(deviceId);

  if (topic.endsWith("/events")) {
    if (msg.type === "sensor_trigger") {
      // Hardware update: every ESP32 now carries its own relays + hooter +
      // one PIR sensor. The device already sounds its own hooter locally and
      // instantly on trigger (see firmware/src/main.cpp) — no pairing, no
      // hub lookup, no cloud round-trip needed for that any more. The
      // cloud's job here is purely logging + notification.
      const device = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId);
      if (!device) {
        console.warn(`[mqtt] sensor_trigger from unknown device_id=${deviceId}, ignoring`);
        return;
      }
      const alertActive = !!device.alert_mode_active;

      db.prepare(
        "INSERT INTO sensor_events (device_id, alert_mode_active) VALUES (?, ?)"
      ).run(deviceId, alertActive ? 1 : 0);

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
    // heartbeat: last_seen update above is enough for the prototype
  }

  if (topic.endsWith("/state")) {
    db.prepare(
      `UPDATE devices SET relay1_state = ?, relay2_state = ?, hooter_state = ?, alert_mode_active = ?
       WHERE device_id = ?`
    ).run(
      msg.relay1 ? 1 : 0,
      msg.relay2 ? 1 : 0,
      msg.hooter ? 1 : 0,
      msg.alert_mode_active ? 1 : 0,
      deviceId
    );

    const userId = ownerOf(deviceId);
    if (userId) {
      pushToUser(userId, { type: "device_state", device_id: deviceId, ...msg });
    }
  }
});

export function sendCommand(deviceId, command) {
  client.publish(`devices/${deviceId}/commands`, JSON.stringify(command));
}

export function setAlertMode(deviceId, active) {
  sendCommand(deviceId, { type: "alert_mode_set", active });
}

export function setRelay(deviceId, relayIndex, state) {
  sendCommand(deviceId, { type: "relay_set", relay_index: relayIndex, state });
}
