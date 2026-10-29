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
3. Changes elsewhere (e.g. `scripts/`, docs) don't auto-deploy; they reach the server on the next deploy.
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

## Backups

`scripts/backup-db.sh` takes a consistent online backup of the SQLite DB into `~/backups/` on the
server (gzip, keeps newest 14). Run manually: `/opt/home-security/scripts/backup-db.sh`.

Backups live on the same instance, so they protect against bad data/deploys, not losing the instance.
Copy one to your Mac occasionally:
```bash
scp -i ~/Documents/home_security_new "ubuntu@13.206.228.27:backups/*.gz" ~/Downloads/
```

Restore (stops the backend briefly):
```bash
cd /opt/home-security
gunzip -c ~/backups/data-YYYYMMDD-HHMMSS.sqlite.gz > /tmp/restore.sqlite
docker compose -f docker-compose.prod.yml stop backend
docker run --rm -v home-security_backend-data:/data -v /tmp:/r alpine \
  sh -c "rm -f /data/data.sqlite-wal /data/data.sqlite-shm && cp /r/restore.sqlite /data/data.sqlite"
docker compose -f docker-compose.prod.yml start backend
```

## Server hardening already in place

- Docker starts on boot; both containers `restart: unless-stopped`.
- Container logs capped at 3 × 10 MB each; build cache pruned on every deploy (disk is only 8 GB).
- Backend Docker healthcheck hits `/health` every 30s.
- SSH: key-only, password auth off, root login key-only.
- Ubuntu unattended security upgrades enabled.

## Pending one-time setup (needs the maintainer to run it)

Daily backups via cron and 1 GB swap (the 1 GB RAM box can run out of memory while compiling
`better-sqlite3` during a build). Check with `crontab -l` and `swapon --show`; if missing, run on the server:
```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
(crontab -l 2>/dev/null; echo "30 20 * * * /opt/home-security/scripts/backup-db.sh >> \$HOME/backups/backup.log 2>&1") | crontab -
```
(20:30 UTC = 02:00 IST.)

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

- Auth token is the raw user id — unsigned, never expires (`backend/src/auth-middleware.js`).
- Mosquitto allows anonymous clients, no TLS (`mosquitto/mosquitto.conf`), and is open to the internet.
- No HTTPS on the API.
- Single instance, backups on the same disk, SQLite (fine for a prototype, not for scale).

## Local development

`docker-compose.yml` (no `.prod`) runs only Mosquitto for local dev; run the backend with
`cd backend && npm install && npm run dev`. See `README.md` → "Running it yourself".
