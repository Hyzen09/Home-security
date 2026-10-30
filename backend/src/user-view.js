import db from "./db.js";

export const DEFAULT_SETTINGS = { alert_tone: "siren" };

export function settingsOf(user) {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(user.settings || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Keeps a leading "+" and digits only, so "+91 98765-43210" and
// "+919876543210" are the same account.
export function normalizePhone(raw) {
  const s = String(raw ?? "").trim();
  const digits = s.replace(/\D/g, "");
  if (!digits) return "";
  return (s.startsWith("+") ? "+" : "") + digits;
}

// Passwords are deliberately left out; they're only returned by
// GET /me/wifi-networks.
export function toProfile(user) {
  const devices = db
    .prepare("SELECT device_id, name FROM devices WHERE owner_user_id = ? ORDER BY created_at")
    .all(user.id);
  const networks = db.prepare("SELECT id, ssid FROM wifi_networks WHERE user_id = ? ORDER BY id").all(user.id);
  return {
    user_id: user.id,
    user_name: user.name,
    phone_number: user.phone,
    esp_device_ids: Object.fromEntries(devices.map((d) => [d.name || d.device_id, d.device_id])),
    wifi_networks: networks,
    settings: settingsOf(user),
  };
}
