import { Router } from "express";
import db from "../db.js";
import { settingsOf, toProfile } from "../user-view.js";

const router = Router();

router.get("/", (req, res) => {
  res.json(toProfile(req.user));
});

// Tone ids are only format-checked, not allowlisted, so new tones can ship
// in the app without a backend deploy; the app falls back on unknown ids.
router.patch("/settings", (req, res) => {
  const settings = settingsOf(req.user);
  const { alert_tone } = req.body || {};

  if (alert_tone !== undefined) {
    if (typeof alert_tone !== "string" || !/^[a-z0-9_-]{1,32}$/.test(alert_tone)) {
      return res.status(400).json({ error: "alert_tone must be a short tone id" });
    }
    settings.alert_tone = alert_tone;
  }

  db.prepare("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(settings), req.user.id);
  res.json(settings);
});

// ---------------- Saved WiFi networks ----------------

// Same limits the unit's WiFi stack enforces: SSID up to 32 bytes; WPA2
// passphrase 8-63 characters, or empty for an open network.
function validateNetwork(ssid, password) {
  if (typeof ssid !== "string" || !ssid.trim()) return "WiFi name is required";
  if (Buffer.byteLength(ssid, "utf8") > 32) return "WiFi name must be 32 bytes or fewer";
  if (typeof password !== "string") return "password must be a string";
  if (password !== "" && (password.length < 8 || password.length > 63)) {
    return "WiFi password must be 8–63 characters (or empty for an open network)";
  }
  return null;
}

function networksOf(userId) {
  const devicesBySsid = new Map();
  for (const d of db
    .prepare("SELECT name, wifi_ssid FROM devices WHERE owner_user_id = ? AND wifi_ssid IS NOT NULL ORDER BY created_at")
    .all(userId)) {
    if (!devicesBySsid.has(d.wifi_ssid)) devicesBySsid.set(d.wifi_ssid, []);
    devicesBySsid.get(d.wifi_ssid).push(d.name);
  }
  return db
    .prepare("SELECT id, ssid, password, updated_at FROM wifi_networks WHERE user_id = ? ORDER BY id")
    .all(userId)
    .map((n) => ({ ...n, device_names: devicesBySsid.get(n.ssid) || [] }));
}

const networkById = (userId, id) => networksOf(userId).find((n) => n.id === Number(id));

router.get("/wifi-networks", (req, res) => {
  res.json(networksOf(req.user.id));
});

// Saving a network whose name already exists updates its password.
router.post("/wifi-networks", (req, res) => {
  const ssid = req.body?.ssid;
  const password = req.body?.password ?? "";
  const error = validateNetwork(ssid, password);
  if (error) return res.status(400).json({ error });

  const existing = db.prepare("SELECT id FROM wifi_networks WHERE user_id = ? AND ssid = ?").get(req.user.id, ssid);
  if (existing) {
    db.prepare("UPDATE wifi_networks SET password = ?, updated_at = datetime('now') WHERE id = ?").run(
      password,
      existing.id
    );
    return res.json(networkById(req.user.id, existing.id));
  }
  const { lastInsertRowid } = db
    .prepare("INSERT INTO wifi_networks (user_id, ssid, password) VALUES (?, ?, ?)")
    .run(req.user.id, ssid, password);
  res.status(201).json(networkById(req.user.id, lastInsertRowid));
});

router.patch("/wifi-networks/:id", (req, res) => {
  const current = networkById(req.user.id, req.params.id);
  if (!current) return res.status(404).json({ error: "network not found" });

  const ssid = req.body?.ssid ?? current.ssid;
  const password = req.body?.password ?? current.password;
  const error = validateNetwork(ssid, password);
  if (error) return res.status(400).json({ error });

  const clash = db
    .prepare("SELECT 1 FROM wifi_networks WHERE user_id = ? AND ssid = ? AND id != ?")
    .get(req.user.id, ssid, current.id);
  if (clash) return res.status(409).json({ error: `You already saved a network named "${ssid}"` });

  db.prepare("UPDATE wifi_networks SET ssid = ?, password = ?, updated_at = datetime('now') WHERE id = ?").run(
    ssid,
    password,
    current.id
  );
  res.json(networkById(req.user.id, current.id));
});

// Units already on this network keep working: each has its own copy.
router.delete("/wifi-networks/:id", (req, res) => {
  const { changes } = db.prepare("DELETE FROM wifi_networks WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  if (!changes) return res.status(404).json({ error: "network not found" });
  res.json({ ok: true });
});

export default router;
