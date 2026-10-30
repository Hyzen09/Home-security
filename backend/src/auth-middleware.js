import { userForToken } from "./sessions.js";

// PROTOTYPE AUTH: random session tokens from POST /auth/register and
// /auth/login, but no OTP/password behind them (name + phone is the whole
// credential) and no expiry. Needs phone verification before real users.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing bearer token" });

  const user = userForToken(token);
  if (!user) return res.status(401).json({ error: "invalid or expired session" });

  req.user = user;
  req.token = token;
  next();
}
