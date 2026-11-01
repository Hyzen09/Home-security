# Deployment

How the backend is hosted, how changes reach production, and how to operate it.
Last verified working: 2026-11-01 (deploys of `b938f14`, `1fb0848`, `743a91c`; production healthy with a live unit).

> This repo is **public**. Never commit secrets, `.env` files, or private keys here.

## At a glance

| What | Value |
|---|---|
| Host | AWS EC2, region `ap-south-1` (Mumbai), Ubuntu 26.04, 2 vCPU / 1 GB RAM / 8 GB disk |
| Address | Elastic IP `13.206.228.27` (fixed; survives reboots) |
| Backend API | `http://13.206.228.27:4000` (health: `/health` → `{"ok":true,"mqtt":true}`; `mqtt` is the backend's own link to the broker) |
| MQTT broker | `mqtt://13.206.228.27:1883` (Mosquitto, anonymous, no TLS — prototype) |
| App dir on server | `/opt/home-security` (a git clone of this repo, tracking `main`) |
| Runtime | Docker Compose, file `docker-compose.prod.yml` |
| Database | SQLite in Docker volume `home-security_backend-data`, at `/data/data.sqlite` in the container |
| Backend config | `/opt/home-security/backend/.env` on the server only (not in git, mode 600) |
| CI/CD | GitHub Actions `.github/workflows/deploy.yml` |
| SSH user | `ubuntu` |
| SSH key | `~/Documents/home_security_new` on the maintainer's Mac (ed25519). Only this key is in the server's `authorized_keys`. |

No domain, no TLS, no reverse proxy — a deliberate choice for the prototype stage.

## How a change gets to production

1. Commit and push to `main`.
2. If the push touches `backend/**`, `mosquitto/**`, `docker-compose.prod.yml`, or the workflow file,
   GitHub Actions SSHes into the instance and runs:
   - `git fetch` + `git reset --hard origin/main` in `/opt/home-security`
   - `docker compose -f docker-compose.prod.yml up -d --build`
   - polls `http://localhost:4000/health` for up to 60s; **the run fails and prints backend logs if it never becomes healthy**
   - prunes old images and build cache older than 72h
3. Changes elsewhere (e.g. docs) don't auto-deploy; they reach the server on the next deploy.
   To deploy manually: GitHub → Actions → Deploy to EC2 → Run workflow, or
   `gh workflow run deploy.yml --repo Hyzen09/Home-security`.

Anything edited directly on the server inside `/opt/home-security` (except gitignored files like
`backend/.env`) is **wiped by the next deploy**. Always change code through git.

Watch a deploy from the terminal:
```bash
gh run list --repo Hyzen09/Home-security --workflow deploy.yml --limit 3
gh run watch <run-id> --repo Hyzen09/Home-security
gh run view <run-id> --repo Hyzen09/Home-security --log-failed
```

## GitHub secrets (Settings → Secrets and variables → Actions → Repository secrets)

| Secret | Value |
|---|---|
| `EC2_HOST` | `13.206.228.27` |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | full contents of `~/Documents/home_security_new`, **including** the `-----BEGIN/END OPENSSH PRIVATE KEY-----` lines |

Set the key from the file, never by hand-copying (hand-copying dropped the BEGIN/END lines once and broke deploys):
```bash
gh secret set EC2_SSH_KEY --repo Hyzen09/Home-security < ~/Documents/home_security_new
```

## AWS security group (inbound)

| Port | Source | Why |
|---|---|---|
| 22 | `0.0.0.0/0` | GitHub Actions runners have changing IPs; restricting to "My IP" breaks deploys. Password login is disabled, key-only. |
| 4000 | `0.0.0.0/0` | Backend API for the app |
| 1883 | `0.0.0.0/0` | MQTT for devices |

Opening a new port (e.g. for TLS later) requires adding a rule here in the AWS console **and** a port
mapping in `docker-compose.prod.yml`.

## Common operations

SSH in:
```bash
ssh -i ~/Documents/home_security_new ubuntu@13.206.228.27
cd /opt/home-security
```

On the server (`C="docker compose -f docker-compose.prod.yml"` saves typing):
```bash
$C ps                          # status (backend shows "healthy")
$C logs -f --tail 100 backend  # backend logs
$C logs -f --tail 100 mosquitto
$C restart backend
curl -s localhost:4000/health
```

Change a config value (`PORT`, `MANUFACTURING_KEY`, a new env var):
```bash
nano backend/.env
$C up -d --force-recreate backend
```
A new env var must also be added to `backend/.env.example` in git so the next person knows it exists.

**Finding the `MANUFACTURING_KEY`.** `tools/flash-device.sh` needs it to register a new unit (the server answers 403 without it).
It lives only in `backend/.env` on the server. Read it straight into a gitignored file without printing it:
```bash
ssh -i ~/Documents/home_security_new ubuntu@13.206.228.27 \
  "grep '^MANUFACTURING_KEY=' /opt/home-security/backend/.env | cut -d= -f2-" > tools/.manufacturing-key
MANUFACTURING_KEY="$(tr -d '\n' < tools/.manufacturing-key)" tools/flash-device.sh
```
If the line is missing the backend falls back to the built-in default `dev-manufacturing-key`. To set a new key, edit `.env`,
then `$C up -d --force-recreate backend` (the database is kept; already-flashed units don't use the key).

Roll back a bad deploy: `git revert <bad-sha> && git push` from your machine — the pipeline redeploys
the previous state. Avoid `git reset` on the server; the next deploy undoes it.

The database is not backed up (a deliberate choice). It survives deploys and reboots because it
lives in a Docker volume, but it is lost if the volume or the instance is deleted. Never run
`docker compose down -v` or `docker volume rm` on the server.

## Database (schema v4, prototype 2)

SQLite tables (`backend/src/db.js`):
- `users` — name, unique phone, `settings` JSON (`alert_tone`)
- `sessions` — SHA-256 of each random bearer token → user (logout deletes; no expiry yet)
- `wifi_networks` — the account's saved WiFi networks (SSID + password, plain text), unique per user
- `devices` — unit identity/secret, owner, name, `wifi_ssid` it claimed on, and live state:
  `green_state`/`yellow_state`/`red_state`/`buzzer_state`, `alarm_state`, `presence`, `alert_mode_active`,
  `radar_ok`, `target_cm`, and `radar_settings` JSON (`max_range_units`, `no_person_delay_s`, `sensitivity`,
  `near_threshold`) as last reported by the unit, and `reset_pending` (set when the owner removes the unit in the app,
  cleared when it resets itself or is claimed again)
- `sensor_events` — radar presence detections

`PRAGMA user_version` holds the schema version. When `SCHEMA_VERSION` in `db.js` is higher than the
database's, the backend **drops all tables and starts empty** on its next start (that's how prototype-1
data was truncated on 2026-10-30; v3 wiped prototype-2 data on 2026-10-31 when the empty-room calibration
columns were removed; v4 wiped everything on 2026-11-01 for a from-scratch connectivity test). Only bump it when you mean to wipe production. A wipe also deletes the units'
identities, so every unit has to be re-registered and re-flashed with `tools/flash-device.sh`.

Device protocol over MQTT (see `backend/src/mqtt.js`): commands `output_set` (green/yellow/red/buzzer),
`alert_mode_set`, `alarm_stop`, `radar_config` (range, no-person delay, sensitivity, close-range threshold),
`ping`, `sync`; units publish retained `state` and `sensor_trigger`/`heartbeat`/`radar_info` events.

**Online / offline.** Every 5 s the backend sends `ping` to each claimed unit, and the unit answers with a
`heartbeat` event (it also sends one every 30 s on its own). Any live (non-retained) message from a unit
refreshes `devices.last_seen`; a unit not heard from for 15 s (`OFFLINE_AFTER_MS` in `device-view.js`, three missed
pings) is `online: false` in the API and the app gets a `device_status` push when that changes (checked every 1 s), so a
pulled plug shows as Offline in about 15–16 s. Don't go much lower: a unit can be busy for a few seconds (saving radar
settings, reconnecting) and a threshold under ~10 s would flip it offline for no reason.
Retained state replayed by the broker doesn't count as live. Commands to an offline unit get HTTP 409
(`alarm/stop` is still allowed), and presence/alarm/target are reported as clear/none while it's offline.
A unit that loses WiFi retries the saved network every 20 s indefinitely and comes back online by itself.
A unit that can't reach the broker backs off its retries (3 s up to 30 s) and each attempt blocks it for at most 4 s,
so its radar and local alarm keep working with the internet down. A unit that couldn't claim itself (server
unreachable) keeps retrying every 30 s instead of waiting for a power cycle.

**Removing a unit in the app resets it.** `DELETE /devices/:id` unclaims the unit, sets `devices.reset_pending = 1`
and sends the unit a `sync` nudge. The nudge is not trusted (the broker is open to anyone): the unit answers it by
calling `POST /provisioning/status` with its `device_secret`, and only if that says `reset: true` does it factory-reset
itself (forgets WiFi/owner, back to its `SECURE-<id>` hotspot, so it can be added again). A unit that was offline at
the time is pinged like a claimed one and nudged again, at most every 10 s, as soon as it answers, so it resets itself
the moment it is back. `/provisioning/reset-device` and a new claim both clear the flag, so a stale flag can never
reset a unit that was set up again. Units on older firmware ignore `sync`; they still need the 5 s BOOT-button reset.

**App live connection.** The WebSocket (`/ws`) gets a `{"type":"hb"}` message and a protocol ping every 20 s; sockets
that don't answer the ping are terminated. The app reconnects when it hears nothing for 60 s, so a connection that
died silently (phone changed network, NAT timeout) can't hide alarms. The broker replaying a unit's *retained* state
(after a backend restart) updates the database but is not pushed to the app.

## Server hardening already in place

- Docker starts on boot; both containers `restart: unless-stopped`.
- Container logs capped at 3 × 10 MB each; build cache pruned on every deploy (disk is only 8 GB).
- Backend Docker healthcheck hits `/health` every 30s.
- SSH: key-only, password auth off, root login key-only.
- Ubuntu unattended security upgrades enabled.

## Pending one-time setup (needs the maintainer to run it)

1 GB swap (the 1 GB RAM box can run out of memory while compiling `better-sqlite3` during a build).
Check with `swapon --show`; if empty, run on the server:
```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `curl` to `:4000` or `:1883` times out from outside, but works via `curl localhost` on the server | Security group rule missing for that port. |
| Action log: `ssh.ParsePrivateKey: ssh: no key found` | `EC2_SSH_KEY` is empty or missing its BEGIN/END lines. Re-set it with `gh secret set ... < keyfile`. |
| Action log: `unable to authenticate` with a key that parses | Key isn't in the server's `~/.ssh/authorized_keys`. |
| Action log: `i/o timeout` on port 22 | Port 22 not open to `0.0.0.0/0` in the security group. |
| Deploy fails with "backend failed health check" | The new code crashes at startup; the run log includes the last 50 backend log lines. Fix and push, or revert. |
| Build gets killed / hangs | Out of memory — make sure swap is on (see above). |
| Disk full | `docker system df`, then `docker builder prune -af` and `docker image prune -af`. |
| Random IPs in Mosquitto logs ("protocol error") | Internet scanners. Expected while the broker is anonymous and public. |
| `/health` shows `"mqtt":false` | The backend can't reach its broker: check `$C ps` (mosquitto running?) and `$C logs mosquitto`. While it is false the backend says nothing about units (it can't know), but the app's REST view shows units Offline after 15 s without messages. |
| Every unit shows Offline right after a deploy | Expected for a few seconds: the backend restarts, re-subscribes and pings; units answer within 5 s and flip back to Online. If it lasts longer, check `/health` and the mosquitto container. |
| A deploy "worked" but a config change in `mosquitto.conf` isn't live | A push only recreates the broker if its compose definition changed; edited config needs `$C restart mosquitto` on the server (this briefly drops every unit and the backend; they reconnect by themselves). |

Rotating the SSH key: generate a new keypair, append its `.pub` to `~/.ssh/authorized_keys` on the
server (using the old key), test login with the new key, update `EC2_SSH_KEY`, then remove the old
line from `authorized_keys`. Never paste a private key into chat, issues, or logs.

## Known gaps before real users (prototype shortcuts)

- Login is name + phone with no OTP; sessions never expire.
- Saved WiFi passwords are stored in plain text and sent over plain HTTP (no HTTPS on the API yet).
- Mosquitto allows anonymous clients, no TLS (`mosquitto/mosquitto.conf`), and is open to the internet —
  which is why WiFi passwords are never sent over MQTT (changing a unit's network = reset + re-add).
- Single instance, no database backups, SQLite (fine for a prototype, not for scale).

## Android app download (GitHub Releases)

The app source (`app/`) isn't in this repo, but its APK is published as a release asset.
Permanent link to the newest version (works as long as the asset is named `home-security.apk`):
`https://github.com/Hyzen09/Home-security/releases/latest/download/home-security.apk`

Publish a new version from the maintainer's Mac (bump `version:` in `app/pubspec.yaml` first) with `tools/release-app.sh`.
It builds the release APK **explicitly against production** (`--dart-define=BACKEND_HOST=13.206.228.27`) and refuses to bless
the APK unless every check passes:

```bash
tools/release-app.sh                                   # build + check, no publishing
tools/release-app.sh --check path/to/app-release.apk   # check an existing APK only
tools/release-app.sh --publish app-vX.Y.Z --notes-file notes.md [--allow-debug-signing]
```
Checks: version matches `pubspec.yaml`; not debuggable; signature and zipalign verify; **every ABI's `libapp.so` contains
`13.206.228.27:4000` and no `192.168.x.x` / `127.0.0.1` / `localhost` / `10.0.2.2` backend address**. `--publish` creates the
release with the asset named `home-security.apk` (this keeps the permanent link above working) and then compares GitHub's stored
SHA-256 with the local build. A debug-signed APK needs `--allow-debug-signing` to be published, so it is a conscious choice.
Current release: **app-v2.3.0** (signed with the release key; v2.2.0 rebuilt from the same source reproduced its SHA-256 byte for byte).

Manual equivalent (what the script automates): `flutter build apk --release --dart-define=BACKEND_HOST=13.206.228.27`, then
`gh release create app-vX.Y.Z home-security.apk --repo Hyzen09/Home-security --target main --notes-file notes.md`, then
`gh api repos/Hyzen09/Home-security/releases/tags/app-vX.Y.Z --jq '.assets[0].digest'` against `shasum -a 256`.

**Release signing.** Since v2.3.0 the APK is signed with a dedicated release keystore, `~/Documents/home-security-release.jks`
(alias `home-security`, RSA 2048, valid to 2054), configured through `app/android/key.properties` (both gitignored; the password
lives only in `key.properties`). Gradle uses it automatically when `key.properties` exists and falls back to the debug key when it
doesn't, in which case `tools/release-app.sh` warns and `--publish` needs `--allow-debug-signing`.
**Back up the `.jks` file and its password** (e.g. in a password manager): if they are lost nobody can ever update the app in place,
and every phone would have to uninstall first. Never commit or share them. Releases up to v2.2.0 were signed with a different (debug)
key, so moving from them to v2.3.0 or later needs a one-time uninstall; from v2.3.0 on, updates install normally.

**Not production-grade yet:** the app talks plain HTTP/WebSocket (`usesCleartextTraffic`) because the server has no TLS (no domain
yet). Listed under "Known gaps before real users".

## Local development

`docker-compose.yml` (no `.prod`) runs only Mosquitto for local dev; run the backend with
`cd backend && npm install && npm run dev`. See `README.md` → "Running it yourself".
