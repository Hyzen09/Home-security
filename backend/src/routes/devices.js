import { Router } from "express";
import db from "../db.js";
import { setAlertMode, setRelay } from "../mqtt.js";
import { toPublicDevice } from "../device-view.js";

const router = Router();

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM devices WHERE owner_user_id = ?").all(req.user.id);
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

router.patch("/:id", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const name = String(req.body?.name ?? "").trim();
  if (!name || name.length > 40) return res.status(400).json({ error: "Name must be 1–40 characters" });

  const clash = db
    .prepare("SELECT 1 FROM devices WHERE owner_user_id = ? AND device_id != ? AND lower(name) = lower(?)")
    .get(req.user.id, device.device_id, name);
  if (clash) return res.status(409).json({ error: `You already have a device named "${name}"` });

  db.prepare("UPDATE devices SET name = ? WHERE device_id = ?").run(name, device.device_id);
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

router.patch("/:id/relay/:n", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const relayIndex = Number(req.params.n);
  if (![1, 2].includes(relayIndex)) return res.status(400).json({ error: "relay must be 1 or 2" });
  const { state } = req.body || {};
  if (typeof state !== "boolean") return res.status(400).json({ error: "state (boolean) required" });

  setRelay(device.device_id, relayIndex, state);
  res.json({ ok: true, requested: { relay: relayIndex, state } });
});

router.patch("/:id/alert-mode", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ error: "active (boolean) required" });

  // No billing gate any more (payment gateway removed) - alert mode is
  // freely toggleable.
  setAlertMode(device.device_id, active);
  res.json({ ok: true, requested: { active } });
});

// Unclaims rather than deleting the row: device_secret (the unit's
// permanent factory credential) must survive this, since the physical unit
// still has it burned in and would otherwise be unable to ever self-claim
// again. The unit itself isn't told — it keeps believing it's claimed until
// it's physically re-provisioned (new owner_user_id over its local
// hotspot) or factory-reset.
router.delete("/:id", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  db.prepare("UPDATE devices SET status = 'unclaimed', owner_user_id = NULL, name = NULL WHERE device_id = ?").run(
    device.device_id
  );
  res.json({ ok: true });
});

export default router;
