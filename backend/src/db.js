import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so Docker can point this at a mounted volume instead of the
// container's writable layer (which is wiped on every rebuild).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hardware update: every ESP32 is now identical and self-contained — 2 relays
-- + 1 hooter + 1 PIR sensor each. No more hub/sensor split, no pairing.
-- device_secret is burned in at flash time by the .exe provisioning tool and
-- is the device's permanent credential (never nulled) — it's what the device
-- itself presents to POST /provisioning/claim-device to prove its identity,
-- replacing the old single-use QR claim_token.
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_secret TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'unclaimed', -- unclaimed | claimed
  firmware_version TEXT,
  last_seen TEXT,
  alert_mode_active INTEGER NOT NULL DEFAULT 0,
  relay1_state INTEGER NOT NULL DEFAULT 0,
  relay2_state INTEGER NOT NULL DEFAULT 0,
  hooter_state INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- device_id identifies which unit fired (each ESP32 = exactly one sensor,
-- so there's no separate sensor_index to track).
CREATE TABLE IF NOT EXISTS sensor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  alert_mode_active INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export default db;
