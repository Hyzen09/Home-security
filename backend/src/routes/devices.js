import { Router } from "express";
import db from "../db.js";
import { requestSync, setAlertMode, setOutput, stopAlarm } from "../mqtt.js";
import { LABELS, LABEL_MAX, OUTPUTS, isOnline, toPublicDevice } from "../device-view.js";

const router = Router();

// Commands are fire-and-forget over MQTT, so a unit that's off would drop them
// silently and the app would show a switch that did nothing. Say so instead.
function onlineOr409(device, res) {
  if (isOnline(device)) return true;
  res.status(409).json({
    error: `${device.name || device.device_id} is offline. Check that it's plugged in and within WiFi range.`,
    offline: true,
  });
  return false;
}

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM devices WHERE owner_user_id = ? ORDER BY created_at").all(req.user.id);
  res.json(rows.map(toPublicDevice));
});

function ownedDeviceOr404(req, res) {
  const device = db
    .prepare("SELECT * FROM devices WHERE device_id = ? AND owner_user_id = ?")
    .get(req.params.id, req.user.id);
  if (!device) res.status(404).json({ error: "device not found" });
  return device;
}

router.get("/:id", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  res.json(toPublicDevice(device));
});

// Renames the unit and/or its relays; send only the fields that change.
// An empty relay name (or null) goes back to the app's default (the pin name).
router.patch("/:id", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const body = req.body || {};
  const updates = {};

  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 40) return res.status(400).json({ error: "Name must be 1–40 characters" });
    const clash = db
      .prepare("SELECT 1 FROM devices WHERE owner_user_id = ? AND device_id != ? AND lower(name) = lower(?)")
      .get(req.user.id, device.device_id, name);
    if (clash) return res.status(409).json({ error: `You already have a device named "${name}"` });
    updates.name = name;
  }
  for (const label of LABELS) {
    if (body[label] === undefined) continue;
    if (body[label] !== null && typeof body[label] !== "string") {
      return res.status(400).json({ error: `${label} must be a string` });
    }
    const value = (body[label] ?? "").trim();
    if (value.length > LABEL_MAX) return res.status(400).json({ error: `Names must be ${LABEL_MAX} characters or fewer` });
    updates[label] = value || null;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: `Send name or one of ${LABELS.join(", ")}` });
  }

  // Column names come from the fixed list above, never from the request.
  const columns = Object.keys(updates);
  db.prepare(`UPDATE devices SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE device_id = ?`).run(
    ...columns.map((c) => updates[c]),
    device.device_id
  );
  res.json(toPublicDevice(db.prepare("SELECT * FROM devices WHERE device_id = ?").get(device.device_id)));
});

router.get("/:id/events", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const events = db
    .prepare("SELECT * FROM sensor_events WHERE device_id = ? ORDER BY id DESC LIMIT ?")
    .all(device.device_id, limit);
  res.json(events);
});

// The two relays the app switches (relay1 = D19, relay2 = D21).
router.patch("/:id/outputs/:output", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const { output } = req.params;
  if (!OUTPUTS.includes(output)) {
    return res.status(400).json({ error: `output must be one of ${OUTPUTS.join(", ")}` });
  }
  const { state } = req.body || {};
  if (typeof state !== "boolean") return res.status(400).json({ error: "state (boolean) required" });
  if (!onlineOr409(device, res)) return;

  setOutput(device.device_id, output, state);
  res.json({ ok: true, requested: { output, state } });
});

// Silences a sounding alarm but leaves the unit armed for the next detection.
router.post("/:id/alarm/stop", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  stopAlarm(device.device_id);
  res.json({ ok: true });
});

// Disarming also silences an alarm that's currently sounding (handled on the unit).
router.patch("/:id/alert-mode", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ error: "active (boolean) required" });
  if (!onlineOr409(device, res)) return;

  setAlertMode(device.device_id, active);
  res.json({ ok: true, requested: { active } });
});

// Unclaims rather than deleting the row: device_secret (the unit's
// permanent factory credential) must survive this, since the physical unit
// still has it burned in and would otherwise be unable to ever self-claim
// again. The unit is told to factory-reset itself so it goes back to setup mode
// (shows up in "Add device" again): reset_pending records that, and the unit is
// nudged now if it's online, or as soon as it next talks to us if it isn't (mqtt.js).
router.delete("/:id", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  db.prepare(
    `UPDATE devices SET status = 'unclaimed', owner_user_id = NULL, name = NULL, relay1_name = NULL, relay2_name = NULL,
       reset_pending = 1 WHERE device_id = ?`
  ).run(device.device_id);
  requestSync(device.device_id);
  res.json({ ok: true });
});

export default router;
