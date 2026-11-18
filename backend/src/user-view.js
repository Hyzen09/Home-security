import db from "./db.js";

// The night alarm: while a unit's alarm switch is off, the unit arms itself every day
// from start_min to end_min (minutes after local midnight; may cross midnight).
// tz_offset_min is the owner's phone's UTC offset, since the unit only knows UTC (NTP).
export const DEFAULT_SCHEDULE = { enabled: true, start_min: 22 * 60, end_min: 7 * 60, tz_offset_min: 330 };
export const DEFAULT_SETTINGS = { alert_tone: "siren", alarm_schedule: DEFAULT_SCHEDULE };

export function settingsOf(user) {
  let saved = {};
  try {
    saved = JSON.parse(user?.settings || "{}");
  } catch {
    // corrupt settings: defaults
  }
  return { ...DEFAULT_SETTINGS, ...saved, alarm_schedule: { ...DEFAULT_SCHEDULE, ...saved.alarm_schedule } };
}

// The night alarm of a unit's owner (the default for a unit nobody owns yet).
export function scheduleForDevice(deviceId) {
  const owner = db
    .prepare("SELECT u.settings FROM devices d JOIN users u ON u.id = d.owner_user_id WHERE d.device_id = ?")
    .get(deviceId);
  return settingsOf(owner).alarm_schedule;
}

// WiFi passwords are deliberately left out; they're only returned by
// GET /me/wifi-networks. user_name repeats the username for older app builds.
export function toProfile(user) {
  const devices = db
    .prepare("SELECT device_id, name FROM devices WHERE owner_user_id = ? ORDER BY created_at")
    .all(user.id);
  const networks = db.prepare("SELECT id, ssid FROM wifi_networks WHERE user_id = ? ORDER BY id").all(user.id);
  return {
    user_id: user.id,
    username: user.username,
    user_name: user.username,
    esp_device_ids: Object.fromEntries(devices.map((d) => [d.name || d.device_id, d.device_id])),
    wifi_networks: networks,
    settings: settingsOf(user),
  };
}
