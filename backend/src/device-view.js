// Shared device shape for API responses and live pushes, so devices.js,
// provisioning.js and mqtt.js don't drift out of sync.
export const OUTPUTS = ["green", "yellow", "red", "buzzer"];

// One radar distance unit = 0.7 m (Rd-03L_V2 protocol).
export const RADAR_UNIT_M = 0.7;

// A unit counts as online while it has been heard from recently. It sends a
// heartbeat every 30 s and the backend pings every 15 s (mqtt.js), so 45 s of
// silence means it's unplugged or off WiFi.
export const OFFLINE_AFTER_MS = 45_000;

export function isOnline(row, now = Date.now()) {
  if (!row.last_seen) return false;
  const heardAt = Date.parse(row.last_seen.replace(" ", "T") + "Z"); // SQLite datetime('now') is UTC
  return now - heardAt < OFFLINE_AFTER_MS;
}

export function radarSettingsOf(row) {
  try {
    return JSON.parse(row.radar_settings || "{}");
  } catch {
    return {};
  }
}

export function toPublicDevice(row) {
  const radar = radarSettingsOf(row);
  const online = isOnline(row);
  return {
    device_id: row.device_id,
    name: row.name || row.device_id,
    status: row.status,
    firmware_version: row.firmware_version,
    wifi_ssid: row.wifi_ssid,
    last_seen: row.last_seen,
    online,
    alert_mode_active: !!row.alert_mode_active,
    green: !!row.green_state,
    yellow: !!row.yellow_state,
    red: !!row.red_state,
    buzzer: !!row.buzzer_state,
    // What the radar sees is only meaningful while the unit is reachable; for a
    // unit that went quiet mid-alarm it would otherwise stay "sounding" forever.
    alarm: online && !!row.alarm_state,
    presence: online && !!row.presence,
    target_cm: online ? (row.target_cm ?? null) : null,
    radar: {
      connected: !!row.radar_ok,
      max_range_units: radar.max_range_units ?? null,
      no_person_delay_s: radar.no_person_delay_s ?? null,
      sensitivity: radar.sensitivity ?? 0,
      near_threshold: radar.near_threshold ?? 0,
    },
  };
}
