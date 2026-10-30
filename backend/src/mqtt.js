import mqtt from "mqtt";
import db from "./db.js";
import { pushToUser } from "./ws.js";
import { radarSettingsOf, toPublicDevice } from "./device-view.js";

const BROKER_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";

// Device protocol (firmware/src/main.cpp, simulator/device-sim.js):
//   devices/{id}/commands  <- {type:"output_set", output:"green"|"yellow"|"red"|"buzzer", state}
//                             {type:"alert_mode_set", active}
//                             {type:"alarm_stop"}  (silence; stays armed)
//                             {type:"radar_config", max_range_units, no_person_delay_s, sensitivity}
//                             {type:"radar_calibrate"}  (empty-room auto thresholds, ~2 min)
//   devices/{id}/state     -> {green, yellow, red, buzzer, alarm, presence, alert_mode_active,
//                              radar_ok, target_cm, calibrating, calibration_progress, uptime_ms} (retained)
//   devices/{id}/events    -> {type:"sensor_trigger"} on each new presence detection, {type:"heartbeat"},
//                             {type:"radar_info", radar_ok, max_range_units, no_person_delay_s, sensitivity, calibrated},
//                             {type:"radar_config_result"|"radar_calibration", status, error?}

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

  if (topic.endsWith("/events") && msg.type === "radar_info") {
    const settings = {
      ...radarSettingsOf(device),
      sensitivity: Number.isInteger(msg.sensitivity) ? msg.sensitivity : 0,
      calibrated: !!msg.calibrated,
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

  if (topic.endsWith("/events") && (msg.type === "radar_config_result" || msg.type === "radar_calibration")) {
    const userId = ownerOf(deviceId);
    if (userId) {
      pushToUser(userId, { type: msg.type, device_id: deviceId, status: msg.status, error: msg.error ?? null });
    }
  }

  if (topic.endsWith("/state")) {
    const targetCm = Number.isInteger(msg.target_cm) && msg.target_cm >= 0 ? msg.target_cm : null;
    const progress = Number.isInteger(msg.calibration_progress) ? msg.calibration_progress : 0;
    db.prepare(
      `UPDATE devices SET green_state = ?, yellow_state = ?, red_state = ?, buzzer_state = ?,
         alarm_state = ?, presence = ?, alert_mode_active = ?,
         radar_ok = ?, target_cm = ?, calibrating = ?, calibration_progress = ?
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
      bit(msg.calibrating),
      progress,
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
        target_cm: targetCm,
        radar_connected: !!msg.radar_ok,
        calibrating: !!msg.calibrating,
        calibration_progress: progress,
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

export function setRadarConfig(deviceId, { max_range_units, no_person_delay_s, sensitivity }) {
  sendCommand(deviceId, { type: "radar_config", max_range_units, no_person_delay_s, sensitivity });
}

export function startRadarCalibration(deviceId) {
  sendCommand(deviceId, { type: "radar_calibrate" });
}

export function stopAlarm(deviceId) {
  sendCommand(deviceId, { type: "alarm_stop" });
}

export function setOutput(deviceId, output, state) {
  sendCommand(deviceId, { type: "output_set", output, state });
}
