// Shared device shape for API responses and live pushes, so devices.js,
// provisioning.js and mqtt.js don't drift out of sync.
export const OUTPUTS = ["green", "yellow", "red", "buzzer"];

// A unit counts as online while it has been heard from recently. The backend
// pings it every 5 s (mqtt.js) and it answers at once, so 15 s of silence is
// three missed pings in a row: it's unplugged or off WiFi. Lower than that and
// a slow reply (the unit blocks for a few seconds while it reconnects) would
// flip it offline for no reason.
export const OFFLINE_AFTER_MS = 15_000;

export function isOnline(row, now = Date.now()) {
  if (!row.last_seen) return false;
  const heardAt = Date.parse(row.last_seen.replace(" ", "T") + "Z"); // SQLite datetime('now') is UTC
  return now - heardAt < OFFLINE_AFTER_MS;
}

export function toPublicDevice(row) {
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
  };
}
