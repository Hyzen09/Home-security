import { Router } from "express";
import db, { nextDefaultDeviceName } from "../db.js";
import { toPublicDevice } from "../device-view.js";
import { pushToUser } from "../ws.js";

const router = Router();

// Both routes are called by the DEVICE itself (not the app, not a logged-in
// user). No bearer token — device_secret (burned in at flash time) is the
// sole proof of identity, same shared-secret pattern manufacturing.js uses.
function authenticateDevice(req, res) {
  const { device_id, device_secret } = req.body || {};
  if (!device_id || !device_secret) {
    res.status(400).json({ error: "device_id and device_secret required" });
    return null;
  }
  const device = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(device_id);
  if (!device) {
    res.status(404).json({ error: "unknown device_id" });
    return null;
  }
  if (device.device_secret !== device_secret) {
    res.status(403).json({ error: "invalid device secret" });
    return null;
  }
  return device;
}

// Called once the device has joined home WiFi after the app handed it
// {ssid, password, owner_user_id} over the local SoftAP link.
//
// Idempotent on purpose: real firmware retries this on every boot until it
// succeeds, and the dev-only simulator stand-in (simulator/device-sim.js)
// calls it unconditionally on every startup.
router.post("/claim-device", (req, res) => {
  const device = authenticateDevice(req, res);
  if (!device) return;
  const { owner_user_id } = req.body;
  if (!owner_user_id) return res.status(400).json({ error: "owner_user_id required" });

  const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(owner_user_id);
  if (!owner) return res.status(404).json({ error: "unknown owner_user_id" });

  if (device.status === "claimed") {
    if (device.owner_user_id === owner_user_id) {
      // Already claimed by this same account — treat as success so retrying
      // firmware/simulator doesn't see an error on every subsequent boot.
      return res.json(toPublicDevice(device));
    }
    return res.status(409).json({ error: "device already claimed by another account" });
  }

  db.prepare("UPDATE devices SET status = 'claimed', owner_user_id = ?, name = ? WHERE device_id = ?").run(
    owner_user_id,
    nextDefaultDeviceName(owner_user_id),
    device.device_id
  );
  res.json(toPublicDevice(db.prepare("SELECT * FROM devices WHERE device_id = ?").get(device.device_id)));
});

// Long-press factory reset on the unit. Removes it from its owner's account
// and forgets its history so it can be found and added again like a new
// unit. The row itself stays: device_id/device_secret are burned into the
// firmware and are needed to ever claim it again.
router.post("/reset-device", (req, res) => {
  const device = authenticateDevice(req, res);
  if (!device) return;

  db.transaction(() => {
    db.prepare("DELETE FROM sensor_events WHERE device_id = ?").run(device.device_id);
    db.prepare(
      `UPDATE devices SET status = 'unclaimed', owner_user_id = NULL, name = NULL, last_seen = NULL,
         alert_mode_active = 0, relay1_state = 0, relay2_state = 0, hooter_state = 0
       WHERE device_id = ?`
    ).run(device.device_id);
  })();

  console.log(`[provisioning] factory reset device=${device.device_id} previous_owner=${device.owner_user_id}`);
  if (device.owner_user_id) {
    pushToUser(device.owner_user_id, { type: "device_removed", device_id: device.device_id, reason: "factory_reset" });
  }
  res.json({ ok: true });
});

export default router;
