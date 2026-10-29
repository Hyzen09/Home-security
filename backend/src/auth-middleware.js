import db from "./db.js";

// PROTOTYPE AUTH: the bearer token is literally the user id, issued by
// POST /auth/register and /auth/login (see routes/auth.js). No signing,
// no expiry. Replace with a signed JWT (or session token + refresh) before
// this touches a real network.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing bearer token" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(token);
  if (!user) return res.status(401).json({ error: "invalid token" });

  req.user = user;
  next();
}
