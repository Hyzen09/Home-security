# Deployment

How the backend is hosted, how changes reach production, and how to operate it.
Last verified working: 2026-10-29.

> This repo is **public**. Never commit secrets, `.env` files, or private keys here.

## At a glance

| What | Value |
|---|---|
| Host | AWS EC2, region `ap-south-1` (Mumbai), Ubuntu 26.04, 2 vCPU / 1 GB RAM / 8 GB disk |
| Address | Elastic IP `13.206.228.27` (fixed; survives reboots) |
| Backend API | `http://13.206.228.27:4000` (health: `/health` → `{"ok":true}`) |
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

Roll back a bad deploy: `git revert <bad-sha> && git push` from your machine — the pipeline redeploys
the previous state. Avoid `git reset` on the server; the next deploy undoes it.

The database is not backed up (a deliberate choice). It survives deploys and reboots because it
lives in a Docker volume, but it is lost if the volume or the instance is deleted. Never run
`docker compose down -v` or `docker volume rm` on the server.

## Database (schema v2, prototype 2)

SQLite tables (`backend/src/db.js`):
- `users` — name, unique phone, `settings` JSON (`alert_tone`)
- `sessions` — SHA-256 of each random bearer token → user (logout deletes; no expiry yet)
- `wifi_networks` — the account's saved WiFi networks (SSID + password, plain text), unique per user
- `devices` — unit identity/secret, owner, name, `wifi_ssid` it claimed on, and live state:
  `green_state`/`yellow_state`/`red_state`/`buzzer_state`, `alarm_state`, `presence`, `alert_mode_active`
- `sensor_events` — radar presence detections

`PRAGMA user_version` holds the schema version. When `SCHEMA_VERSION` in `db.js` is higher than the
database's, the backend **drops all tables and starts empty** on its next start (that's how prototype-1
data was truncated on 2026-10-30). Only bump it when you mean to wipe production.

Device protocol over MQTT (see `backend/src/mqtt.js`): commands `output_set` (green/yellow/red/buzzer),
`alert_mode_set`, `alarm_stop`; units publish retained `state` and `sensor_trigger`/`heartbeat` events.

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

Publish a new version from the maintainer's Mac (bump `version:` in `app/pubspec.yaml` first):
```bash
cd app && flutter build apk --release
cp build/app/outputs/flutter-apk/app-release.apk /tmp/home-security.apk
gh release create app-vX.Y.Z /tmp/home-security.apk --repo Hyzen09/Home-security --target main \
  --title "Home Security app vX.Y.Z (Android)" --notes "What changed"
```
The APK is signed with this Mac's debug keystore (`~/.android/debug.keystore`). Phones only accept
an update signed with the same key, so build releases on this Mac, or set up a real release key
before distributing widely. The backend address is compiled in from `app/lib/config.dart`.

## Local development

`docker-compose.yml` (no `.prod`) runs only Mosquitto for local dev; run the backend with
`cd backend && npm install && npm run dev`. See `README.md` → "Running it yourself".
