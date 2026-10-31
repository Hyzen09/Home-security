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

// Bump to start from an empty database when the data model changes
// incompatibly. v2 = prototype 2 (traffic-light + buzzer + radar hardware,
// saved WiFi networks, session tokens); all prototype-1 data is discarded.
// v3 = empty-room calibration removed (its devices columns are gone); all v2
// data is discarded.
const SCHEMA_VERSION = 3;
if (db.pragma("user_version", { simple: true }) < SCHEMA_VERSION) {
  db.exec(`
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS wifi_networks;
    DROP TABLE IF EXISTS sensor_events;
    DROP TABLE IF EXISTS devices;
    DROP TABLE IF EXISTS users;
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  console.log(`[db] reset to schema v${SCHEMA_VERSION}`);
}

db.exec(`
-- phone is the account's unique identity (two people can share a name);
-- login requires name + phone to match. settings is a JSON object.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only a SHA-256 of each bearer token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The account's saved WiFi networks, handed to each new unit over its local
-- setup hotspot. Each unit keeps its own copy once provisioned.
CREATE TABLE IF NOT EXISTS wifi_networks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ssid TEXT NOT NULL,
  password TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, ssid)
);

-- One row per physical unit (ESP32 + radar + 3-colour traffic light + buzzer).
-- device_secret is burned in at flash time and is the unit's permanent
-- credential for /provisioning/*. name is the owner's label, unique per
-- owner; wifi_ssid is the network the unit reported when it claimed itself.
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_secret TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  name TEXT,
  status TEXT NOT NULL DEFAULT 'unclaimed', -- unclaimed | claimed
  firmware_version TEXT,
  wifi_ssid TEXT,
  last_seen TEXT,
  alert_mode_active INTEGER NOT NULL DEFAULT 0,
  green_state INTEGER NOT NULL DEFAULT 0,
  yellow_state INTEGER NOT NULL DEFAULT 0,
  red_state INTEGER NOT NULL DEFAULT 0,
  buzzer_state INTEGER NOT NULL DEFAULT 0,
  alarm_state INTEGER NOT NULL DEFAULT 0,
  presence INTEGER NOT NULL DEFAULT 0,
  radar_settings TEXT NOT NULL DEFAULT '{}',
  radar_ok INTEGER NOT NULL DEFAULT 0,
  target_cm INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A presence detection by a unit's radar.
CREATE TABLE IF NOT EXISTS sensor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  alert_mode_active INTEGER NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Additive changes within a schema version (no data loss). radar_settings is
// JSON: {max_range_units, no_person_delay_s, sensitivity, near_threshold}, as last
// reported by the unit.
function addColumnIfMissing(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing("devices", "radar_settings", "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("devices", "radar_ok", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("devices", "target_cm", "INTEGER");

export function nextDefaultDeviceName(ownerUserId) {
  const taken = new Set(
    db
      .prepare("SELECT lower(name) AS n FROM devices WHERE owner_user_id = ? AND name IS NOT NULL")
      .all(ownerUserId)
      .map((r) => r.n)
  );
  for (let i = 1; ; i++) {
    if (!taken.has(`device ${i}`)) return `Device ${i}`;
  }
}

export default db;
