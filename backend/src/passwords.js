import crypto from "crypto";

// Account passwords, stored as "scrypt:<salt hex>:<hash hex>" (Node's built-in scrypt,
// no extra dependency). Comparison is constant-time.
const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

// A throwaway hash, checked against when the username doesn't exist, so a login for an
// unknown user takes as long as one with a wrong password.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

// stored: the account's password_hash, or undefined/null when there is no such account.
export function verifyPassword(password, stored) {
  const known = typeof stored === "string";
  const [scheme, saltHex, hashHex] = (known ? stored : DUMMY_HASH).split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected) && known;
}
