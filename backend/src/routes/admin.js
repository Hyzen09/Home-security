import { Router } from "express";
import crypto from "crypto";
import fs from "fs";
import db from "../db.js";

// Database admin: a web page (GET /admin) plus a small generic CRUD API over
// every table (/admin/api/*). Sign in with ADMIN_USER / ADMIN_PASSWORD from
// backend/.env (POST /admin/api/login); that returns a session token the page
// sends as X-Admin-Token. With either variable unset the admin refuses everything.
//
// The server has no TLS, so the password, token and data cross the network in plain
// text. Brute force is slowed by locking an address out after a few wrong logins.
const router = Router();
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PAGE = fs.readFileSync(new URL("../admin.html", import.meta.url), "utf8");

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const failures = new Map(); // ip -> { count, lockedUntil }
const sessions = new Map(); // sha256(token) -> expires at (ms)

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

router.get("/", (req, res) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.type("html").send(PAGE);
});

const disabled = () => !ADMIN_USER || !ADMIN_PASSWORD;
const DISABLED_MESSAGE = "Admin is disabled: set ADMIN_USER and ADMIN_PASSWORD in backend/.env on the server";

router.post("/api/login", (req, res) => {
  if (disabled()) return res.status(503).json({ error: DISABLED_MESSAGE });
  const record = failures.get(req.ip);
  if (record && record.lockedUntil > Date.now()) {
    const minutes = Math.ceil((record.lockedUntil - Date.now()) / 60_000);
    return res.status(429).json({ error: `Too many wrong logins. Try again in ${minutes} min.` });
  }
  const { username = "", password = "" } = req.body || {};
  // Both comparisons always run, so timing doesn't reveal which one was wrong.
  const userOk = same(username, ADMIN_USER);
  const passOk = same(password, ADMIN_PASSWORD);
  if (!(userOk && passOk)) {
    const lockoutOver = record?.lockedUntil && record.lockedUntil <= Date.now();
    const count = (lockoutOver ? 0 : record?.count ?? 0) + 1;
    failures.set(req.ip, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    console.warn(`[admin] wrong login from ${req.ip} (${count})`);
    return res.status(403).json({ error: "Wrong username or password" });
  }
  failures.delete(req.ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(digest(token).toString("hex"), Date.now() + SESSION_MS);
  console.log(`[admin] login from ${req.ip}`);
  res.json({ token });
});

function requireAdmin(req, res, next) {
  if (disabled()) return res.status(503).json({ error: DISABLED_MESSAGE });
  const id = digest(req.get("x-admin-token") ?? "").toString("hex");
  const expires = sessions.get(id);
  if (!expires || expires < Date.now()) {
    sessions.delete(id);
    return res.status(401).json({ error: "Session expired, sign in again" });
  }
  res.set("Cache-Control", "no-store");
  req.adminSession = id;
  next();
}

const api = Router();
router.use("/api", requireAdmin, api);

api.post("/logout", (req, res) => {
  sessions.delete(req.adminSession);
  res.json({ ok: true });
});

// ---------------- Schema ----------------

function tableNames() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

// Table names only ever come from sqlite_master (never from the request), so
// quoting them into SQL is safe.
function tableInfo(name) {
  if (!tableNames().includes(name)) return null;
  const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => ({
    name: c.name,
    type: c.type,
    notnull: !!c.notnull,
    pk: c.pk > 0,
    default: c.dflt_value,
  }));
  const pks = columns.filter((c) => c.pk);
  return { name, columns, pk: pks.length === 1 ? pks[0].name : null };
}

class Bad extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function tableOr404(req) {
  const info = tableInfo(req.params.table);
  if (!info) throw new Bad(`No table "${req.params.table}"`, 404);
  return info;
}

const handler = (fn) => (req, res) => {
  try {
    res.json(fn(req, res));
  } catch (err) {
    // SQLite constraint errors (NOT NULL, UNIQUE, FOREIGN KEY) are the useful message here.
    const status = err.status ?? (String(err.code).startsWith("SQLITE_CONSTRAINT") ? 409 : 400);
    res.status(status).json({ error: err.message });
  }
};

// A JSON value from the form -> something SQLite should store in this column.
function coerce(value, col) {
  if (value === null) {
    if (col.notnull) throw new Bad(`${col.name} can't be empty`);
    return null;
  }
  if (typeof value === "boolean") value = value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new Bad(`${col.name}: unsupported value`);
  if (/INT/i.test(col.type)) {
    if (value.trim() === "") {
      if (col.notnull) throw new Bad(`${col.name} can't be empty`);
      return null;
    }
    if (!/^-?\d+$/.test(value.trim())) throw new Bad(`${col.name} must be a whole number`);
    return Number(value.trim());
  }
  return value;
}

function valuesFrom(body, info, { allowPk }) {
  const values = body?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Bad("values (object) required");
  const out = {};
  for (const [name, raw] of Object.entries(values)) {
    const col = info.columns.find((c) => c.name === name);
    if (!col) throw new Bad(`Unknown column "${name}"`);
    if (col.pk && !allowPk) throw new Bad(`${name} is the row's key and can't be changed`);
    out[name] = coerce(raw, col);
  }
  return out;
}

function pkOrThrow(info) {
  if (!info.pk) throw new Bad(`${info.name} has no single primary key, so rows can't be addressed`);
  return info.pk;
}

// ---------------- Routes ----------------

api.get(
  "/tables",
  handler(() =>
    tableNames().map((name) => ({
      ...tableInfo(name),
      count: db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n,
    }))
  )
);

api.get(
  "/tables/:table/rows",
  handler((req) => {
    const info = tableOr404(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const q = String(req.query.q ?? "").trim();

    const params = [];
    let where = "";
    if (q) {
      where = "WHERE " + info.columns.map((c) => `CAST("${c.name}" AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ");
      const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      info.columns.forEach(() => params.push(like));
    }
    const total = db.prepare(`SELECT count(*) AS n FROM "${info.name}" ${where}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM "${info.name}" ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { rows, total, limit, offset };
  })
);

api.post(
  "/tables/:table/rows",
  handler((req, res) => {
    const info = tableOr404(req);
    const values = valuesFrom(req.body, info, { allowPk: true });
    const names = Object.keys(values);
    const sql = names.length
      ? `INSERT INTO "${info.name}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
      : `INSERT INTO "${info.name}" DEFAULT VALUES`;
    const result = db.prepare(sql).run(...names.map((n) => values[n]));
    console.log(`[admin] INSERT ${info.name} (${names.join(", ")})`);
    res.status(201);
    return db.prepare(`SELECT * FROM "${info.name}" WHERE rowid = ?`).get(result.lastInsertRowid);
  })
);

api.patch(
  "/tables/:table/rows/:pk",
  handler((req) => {
    const info = tableOr404(req);
    const pk = pkOrThrow(info);
    const values = valuesFrom(req.body, info, { allowPk: false });
    const names = Object.keys(values);
    if (!names.length) throw new Bad("Nothing to change");
    const result = db
      .prepare(`UPDATE "${info.name}" SET ${names.map((n) => `"${n}" = ?`).join(", ")} WHERE "${pk}" = ?`)
      .run(...names.map((n) => values[n]), req.params.pk);
    if (!result.changes) throw new Bad("No such row", 404);
    console.log(`[admin] UPDATE ${info.name} ${req.params.pk} (${names.join(", ")})`);
    return db.prepare(`SELECT * FROM "${info.name}" WHERE "${pk}" = ?`).get(req.params.pk);
  })
);

api.delete(
  "/tables/:table/rows/:pk",
  handler((req) => {
    const info = tableOr404(req);
    const pk = pkOrThrow(info);
    const result = db.prepare(`DELETE FROM "${info.name}" WHERE "${pk}" = ?`).run(req.params.pk);
    if (!result.changes) throw new Bad("No such row", 404);
    console.log(`[admin] DELETE ${info.name} ${req.params.pk}`);
    return { ok: true };
  })
);

export default router;
