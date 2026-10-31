import { Router } from "express";
import db from "../db.js";
import { setAlertMode, setOutput, setRadarConfig, stopAlarm } from "../mqtt.js";
import { OUTPUTS, radarSettingsOf, toPublicDevice } from "../device-view.js";

const router = Router();
const RADAR_NOT_CONNECTED = "The radar's serial pins aren't connected (radar TX → D25, RX → D26)";

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

// Green / yellow / red traffic-light lamps and the buzzer.
router.patch("/:id/outputs/:output", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const { output } = req.params;
  if (!OUTPUTS.includes(output)) {
    return res.status(400).json({ error: `output must be one of ${OUTPUTS.join(", ")}` });
  }
  const { state } = req.body || {};
  if (typeof state !== "boolean") return res.status(400).json({ error: "state (boolean) required" });

  setOutput(device.device_id, output, state);
  res.json({ ok: true, requested: { output, state } });
});

// Radar tuning, applied by the unit over the radar's serial port; the unit
// reports the outcome as a radar_config_result push. Range is in radar units
// of 0.7 m; sensitivity is a dB offset on every gate's threshold (positive =
// fewer false alarms); near_threshold is the trigger threshold in dB of the two
// nearest gates (0 = the radar's own default), where the radar's own leakage
// shows up as a constant detection.
router.patch("/:id/radar", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  const current = radarSettingsOf(device);
  const body = req.body || {};
  const settings = {
    max_range_units: body.max_range_units ?? current.max_range_units ?? 12,
    no_person_delay_s: body.no_person_delay_s ?? current.no_person_delay_s ?? 30,
    sensitivity: body.sensitivity ?? current.sensitivity ?? 0,
    near_threshold: body.near_threshold ?? current.near_threshold ?? 0,
  };
  const outOfRange = (v, lo, hi) => !Number.isInteger(v) || v < lo || v > hi;
  if (outOfRange(settings.max_range_units, 1, 12)) {
    return res.status(400).json({ error: "max_range_units must be 1–12 (0.7–8.4 m)" });
  }
  if (outOfRange(settings.no_person_delay_s, 10, 120)) {
    return res.status(400).json({ error: "no_person_delay_s must be 10–120" });
  }
  if (outOfRange(settings.sensitivity, -30, 20)) {
    return res.status(400).json({ error: "sensitivity must be -30 to +20 dB" });
  }
  if (settings.near_threshold !== 0 && outOfRange(settings.near_threshold, 10, 95)) {
    return res.status(400).json({ error: "near_threshold must be 0 (default) or 10–95 dB" });
  }
  if (!device.radar_ok) return res.status(409).json({ error: RADAR_NOT_CONNECTED });

  setRadarConfig(device.device_id, settings);
  res.status(202).json({ ok: true, requested: settings });
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

  setAlertMode(device.device_id, active);
  res.json({ ok: true, requested: { active } });
});

// Unclaims rather than deleting the row: device_secret (the unit's
// permanent factory credential) must survive this, since the physical unit
// still has it burned in and would otherwise be unable to ever self-claim
// again. The unit itself isn't told; holding its BOOT button for 5s resets it.
router.delete("/:id", (req, res) => {
  const device = ownedDeviceOr404(req, res);
  if (!device) return;
  db.prepare("UPDATE devices SET status = 'unclaimed', owner_user_id = NULL, name = NULL WHERE device_id = ?").run(
    device.device_id
  );
  res.json({ ok: true });
});

export default router;
