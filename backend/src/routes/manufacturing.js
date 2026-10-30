import { Router } from "express";
import crypto from "crypto";
import db from "../db.js";

const router = Router();
const MANUFACTURING_KEY = process.env.MANUFACTURING_KEY || "dev-manufacturing-key";

// Stands in for what the .exe provisioning tool calls after flashing a unit.
// Separate auth (a manufacturing API key, not a user token) because this
// endpoint is only ever meant to be reachable from the factory network.
router.use((req, res, next) => {
  if (req.headers["x-manufacturing-key"] !== MANUFACTURING_KEY) {
    return res.status(403).json({ error: "invalid manufacturing key" });
  }
  next();
});

router.post("/register-device", (req, res) => {
  const { firmware_version } = req.body || {};
  const device_secret = crypto.randomBytes(32).toString("hex");
  const exists = db.prepare("SELECT 1 FROM devices WHERE device_id = ?");

  // device_id is the primary key; regenerate on the (rare) collision instead
  // of failing the flash. Keep it short: the unit's hotspot SSID is
  // "SECURE-<device_id>" and SSIDs max out at 32 bytes.
  let device_id;
  do {
    device_id = "dev-" + crypto.randomBytes(4).toString("hex");
  } while (exists.get(device_id));

  db.prepare(
    "INSERT INTO devices (device_id, device_secret, status, firmware_version) VALUES (?, ?, 'unclaimed', ?)"
  ).run(device_id, device_secret, firmware_version || "0.2.0-proto2");

  res.status(201).json({ device_id, device_secret });
});

export default router;
