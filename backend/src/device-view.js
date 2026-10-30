// Shared device shape for API responses and live pushes, so devices.js,
// provisioning.js and mqtt.js don't drift out of sync.
export const OUTPUTS = ["green", "yellow", "red", "buzzer"];

export function toPublicDevice(row) {
  return {
    device_id: row.device_id,
    name: row.name || row.device_id,
    status: row.status,
    firmware_version: row.firmware_version,
    wifi_ssid: row.wifi_ssid,
    last_seen: row.last_seen,
    alert_mode_active: !!row.alert_mode_active,
    green: !!row.green_state,
    yellow: !!row.yellow_state,
    red: !!row.red_state,
    buzzer: !!row.buzzer_state,
    alarm: !!row.alarm_state,
    presence: !!row.presence,
  };
}
