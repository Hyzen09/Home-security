import { Router } from "express";
import db from "../db.js";
import { toPublicDevice } from "../device-view.js";

const router = Router();

// Called by the DEVICE itself (not the app, not a logged-in user) once it has
// joined home WiFi after the app handed it {ssid, password, owner_user_id}
// over the local SoftAP link (see firmware/src/main.cpp). No bearer token —
// device_secret (burned in at flash time by the .exe tool) is the sole proof
// of identity, same shared-secret pattern manufacturing.js already uses.
//
// Idempotent on purpose: real firmware retries this on every boot until it
// succeeds, and the dev-only simulator stand-in (simulator/device-sim.js)
// calls it unconditionally on every startup.
router.post("/claim-device", (req, res) => {
  const { device_id, device_secret, owner_user_id } = req.body || {};
  if (!device_id || !device_secret || !owner_user_id) {
    return res.status(400).json({ error: "device_id, device_secret and owner_user_id required" });
  }

  const device = db.prepare("SELECT * FROM devices WHERE device_id = ?").get(device_id);
  if (!device) return res.status(404).json({ error: "unknown device_id" });
  if (device.device_secret !== device_secret) {
    return res.status(403).json({ error: "invalid device secret" });
  }

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

  db.prepare("UPDATE devices SET status = 'claimed', owner_user_id = ? WHERE device_id = ?").run(
    owner_user_id,
    device_id
  );
  res.json(toPublicDevice(db.prepare("SELECT * FROM devices WHERE device_id = ?").get(device_id)));
});

export default router;
