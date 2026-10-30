import { Router } from "express";
import crypto from "crypto";
import db from "../db.js";
import { requireAuth } from "../auth-middleware.js";
import { createSession, deleteSession } from "../sessions.js";
import { DEFAULT_SETTINGS, normalizePhone, toProfile } from "../user-view.js";

const router = Router();

// PROTOTYPE AUTH: no OTP, no password — name + phone number is the whole
// credential. Real product needs phone verification.

function readCredentials(req, res) {
  const name = String(req.body?.name ?? "").trim();
  const phone = normalizePhone(req.body?.phone);
  if (!name || !phone) {
    res.status(400).json({ error: "Name and phone number are required" });
    return null;
  }
  if (name.length > 60) {
    res.status(400).json({ error: "Name must be 60 characters or fewer" });
    return null;
  }
  const digitCount = phone.replace("+", "").length;
  if (digitCount < 7 || digitCount > 15) {
    res.status(400).json({ error: "Enter a valid phone number" });
    return null;
  }
  return { name, phone };
}

const session = (user) => ({ token: createSession(user.id), ...toProfile(user) });

router.post("/register", (req, res) => {
  const creds = readCredentials(req, res);
  if (!creds) return;

  if (db.prepare("SELECT 1 FROM users WHERE phone = ?").get(creds.phone)) {
    return res.status(409).json({ error: "An account with this phone number already exists. Log in instead." });
  }

  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, name, phone, settings) VALUES (?, ?, ?, ?)").run(
    id,
    creds.name,
    creds.phone,
    JSON.stringify(DEFAULT_SETTINGS)
  );
  res.status(201).json(session(db.prepare("SELECT * FROM users WHERE id = ?").get(id)));
});

router.post("/login", (req, res) => {
  const creds = readCredentials(req, res);
  if (!creds) return;

  const user = db.prepare("SELECT * FROM users WHERE phone = ?").get(creds.phone);
  if (!user) {
    return res.status(404).json({ error: "No account with this phone number. Register first." });
  }
  if (user.name.trim().toLowerCase() !== creds.name.toLowerCase()) {
    return res.status(401).json({ error: "Name doesn't match this phone number" });
  }
  res.json(session(user));
});

router.post("/logout", requireAuth, (req, res) => {
  deleteSession(req.token);
  res.json({ ok: true });
});

export default router;
