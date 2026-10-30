// Shared device shape for API responses and live pushes, so devices.js,
// provisioning.js and mqtt.js don't drift out of sync.
export const OUTPUTS = ["green", "yellow", "red", "buzzer"];

// One radar distance unit = 0.7 m (Rd-03L_V2 protocol).
export const RADAR_UNIT_M = 0.7;

export function radarSettingsOf(row) {
  try {
    return JSON.parse(row.radar_settings || "{}");
  } catch {
    return {};
  }
}

export function toPublicDevice(row) {
  const radar = radarSettingsOf(row);
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
    target_cm: row.target_cm ?? null,
    radar: {
      connected: !!row.radar_ok,
      max_range_units: radar.max_range_units ?? null,
      no_person_delay_s: radar.no_person_delay_s ?? null,
      sensitivity: radar.sensitivity ?? 0,
      calibrated: !!radar.calibrated,
      calibrating: !!row.calibrating,
      calibration_progress: row.calibration_progress ?? 0,
    },
  };
}
