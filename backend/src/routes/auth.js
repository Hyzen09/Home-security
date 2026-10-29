import { Router } from "express";
import crypto from "crypto";
import db from "../db.js";

const router = Router();

// PROTOTYPE AUTH: no OTP, no password — a phone number alone is both signup
// and login. Find-or-create by phone and hand back a session token
// immediately. Real product needs actual phone verification before a bare
// phone number is trusted as a login credential.
router.post("/register", (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "name and phone required" });

  let user = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (!user) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, name, phone) VALUES (?, ?, ?)").run(id, name, phone);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }
  res.json({ user_id: user.id, token: user.id, name: user.name });
});

export default router;
