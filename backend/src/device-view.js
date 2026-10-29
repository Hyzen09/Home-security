// Shared device shape for API responses. Used by both devices.js (owner-authed
// routes) and provisioning.js (the device's own self-claim call), so the two
// don't drift out of sync.
export function toPublicDevice(row) {
  return {
    device_id: row.device_id,
    status: row.status,
    firmware_version: row.firmware_version,
    last_seen: row.last_seen,
    alert_mode_active: !!row.alert_mode_active,
    relay1_state: !!row.relay1_state,
    relay2_state: !!row.relay2_state,
    hooter_state: !!row.hooter_state,
  };
}
