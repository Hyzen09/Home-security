import crypto from "crypto";
import db from "./db.js";

// Opaque random bearer tokens. Sessions don't expire yet; logout deletes one.
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)").run(hash(token), userId);
  return token;
}

export function userForToken(token) {
  if (!token) return null;
  return (
    db
      .prepare("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ?")
      .get(hash(token)) || null
  );
}

export function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
}
