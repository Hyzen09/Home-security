import { Router } from "express";
import crypto from "crypto";
import db from "../db.js";
import { requireAuth } from "../auth-middleware.js";
import { createSession, deleteSession } from "../sessions.js";
import { hashPassword, verifyPassword } from "../passwords.js";
import { DEFAULT_SETTINGS, toProfile } from "../user-view.js";

const router = Router();

// Accounts are a username + password. The username is unique ignoring case
// ("Vedang" and "vedang" are the same account) and kept as typed for display.
export const USERNAME_RULE = /^[A-Za-z0-9._-]{3,32}$/;
export const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function readCredentials(req, res) {
  const username = String(req.body?.username ?? "").trim();
  const password = req.body?.password;
  if (!username || typeof password !== "string" || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return null;
  }
  return { username, password };
}

// Brute-force brake: after MAX_FAILURES wrong passwords for one username, logins to it
// are refused for LOCKOUT_MS (in memory; a restart clears it).
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;
const failures = new Map(); // lower(username) -> { count, lockedUntil }

router.post("/register", (req, res) => {
  const creds = readCredentials(req, res);
  if (!creds) return;
  if (!USERNAME_RULE.test(creds.username)) {
    return res.status(400).json({ error: "Username must be 3–32 letters, digits, dots, dashes or underscores" });
  }
  if (creds.password.length < PASSWORD_MIN || creds.password.length > PASSWORD_MAX) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters` });
  }
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(creds.username)) {
    return res.status(409).json({ error: "That username is taken. Choose another, or log in." });
  }

  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, username, password_hash, settings) VALUES (?, ?, ?, ?)").run(
    id,
    creds.username,
    hashPassword(creds.password),
    JSON.stringify(DEFAULT_SETTINGS)
  );
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  res.status(201).json({ token: createSession(user.id), ...toProfile(user) });
});

router.post("/login", (req, res) => {
  const creds = readCredentials(req, res);
  if (!creds) return;
  const key = creds.username.toLowerCase();
  const record = failures.get(key);
  if (record?.lockedUntil > Date.now()) {
    const minutes = Math.ceil((record.lockedUntil - Date.now()) / 60_000);
    return res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} min.` });
  }

  // The username lookup ignores case (COLLATE NOCASE).
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(creds.username);
  if (!verifyPassword(creds.password, user?.password_hash)) {
    const lockoutOver = record?.lockedUntil && record.lockedUntil <= Date.now();
    const count = (lockoutOver ? 0 : record?.count ?? 0) + 1;
    failures.set(key, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    // One message for both cases, so the login doesn't reveal which usernames exist.
    return res.status(401).json({ error: "Wrong username or password" });
  }
  failures.delete(key);
  res.json({ token: createSession(user.id), ...toProfile(user) });
});

router.post("/logout", requireAuth, (req, res) => {
  deleteSession(req.token);
  res.json({ ok: true });
});

export default router;
