# Home Security — IoT prototype

**Android app:** [download the latest APK](https://github.com/Hyzen09/Home-security/releases/latest/download/home-security.apk)
(v2.2.0; all versions on the [Releases](https://github.com/Hyzen09/Home-security/releases) page).

A home-security prototype. Each **unit** is an ESP32 with a 24 GHz radar (detects whether someone is in the room), a
traffic light and a buzzer. An **Android app** shows every unit live, switches its lamps and buzzer, arms an *alert mode*
(the unit sounds its own buzzer the instant the radar sees someone new) and tunes the radar. A **cloud backend** (Node.js +
Mosquitto on AWS EC2) sits between them so it works from anywhere, with the app on mobile data and the unit behind a home router.

> **Repo scope:** this repository tracks only the **server-side** code — `backend/`, `mosquitto/`, the compose files and the
> deploy workflow. The Flutter app (`app/`), ESP32 firmware (`firmware/`), `tools/`, `simulator/` and the longer design notes
> (`system_architecture.md`, `Documentation.html`, the SVG diagrams) live in the maintainer's local working tree and are
> gitignored on purpose. The APK is published here under Releases. Server operations are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Architecture

```
 HOME NETWORK                                    INTERNET            AWS EC2 · Docker Compose
┌────────────────────────────────┐                              ┌────────────────────────────────────────┐
│ SECURITY UNIT (ESP32)          │── MQTT :1883 ───────────────▶│ MOSQUITTO 2                            │
│  radar · traffic light ·       │   state (retained), events   │  anonymous · no TLS · no persistence   │
│  buzzer · BOOT button          │◀──────────────────────────── │                                        │
│                                │   commands                   └───────────────▲────────────────────────┘
│                                │                                              │ MQTT client
│                                │── HTTP :4000 ───────────────▶┌───────────────┴────────────────────────┐
│                                │   claim-device, status,      │ BACKEND (Node 20 · Express)            │
└───────────────▲────────────────┘   reset-device               │  REST · WebSocket /ws · MQTT bridge    │
                │ setup only: SoftAP "SECURE-<id>"              │  SQLite on a Docker volume             │
                │ HTTP 192.168.4.1                              └───────────────▲────────────────────────┘
┌───────────────┴────────────────┐                                              │ REST + WebSocket :4000
│ PHONE (Flutter app, Android)   │──────────────────────────────────────────────┘
└────────────────────────────────┘
```

**Why a cloud in the middle:** a phone on mobile data cannot open a connection to a unit behind a home router, and something
has to authenticate users, remember state and push alerts. Units connect *out* to the broker, so no port is opened at home.

**Design rules**

1. **The alarm never depends on the cloud.** Radar → buzzer is decided on the unit, in milliseconds; the cloud only hears
   about it afterwards.
2. **The unit is the source of truth for its own state.** The backend shows what the unit last *reported*; a command is only
   reflected once the unit confirms it.
3. **Nothing is shown as live unless it was heard recently.** A unit that goes quiet shows Offline within about 15 seconds and
   its alarm/presence read as clear.
4. **The open broker is never trusted for identity.** Anyone on the internet can publish to Mosquitto, so a reset or ownership
   change is only ever confirmed over authenticated HTTP using the unit's burned-in secret.
5. **Every unit is identical and self-contained** — no hub, no pairing between units.

**Components**

| Part | Where | What it does |
|---|---|---|
| Security unit | `firmware/` (local) | ESP32 DevKit, Arduino/PlatformIO. Radar on D4 (+ UART D25/D26 for settings), traffic light D18/D19/D21, buzzer D22, BOOT button. Runs the local alarm, MQTT, and the setup hotspot |
| Backend | `backend/` | Express REST API, MQTT bridge, WebSocket push, SQLite. Online/offline tracking, saved WiFi networks, unit registry |
| MQTT broker | `mosquitto/` | Eclipse Mosquitto 2 carrying `devices/<id>/commands · state · events` |
| Android app | `app/` (local), APK on Releases | Flutter. Login, saved WiFi, dashboard, Add Device, radar settings, alarm tone/notification, background monitor |
| Flash tool | `tools/flash-device.sh` (local) | Registers a new unit, burns its identity, erases and flashes the board, checks it boots |
| Hosting / CI | `docker-compose.prod.yml`, `.github/workflows/deploy.yml` | Push to `main` → GitHub Actions → SSH → rebuild on EC2 |

**Key flows** (message-level detail is in `system_architecture.md` / `flow.svg`, kept locally)

- **Add a unit.** Unit (setup mode) hosts the open hotspot `SECURE-<id>` → the app scans, joins it, reads `GET /info`, sends
  `POST /provision {ssid, password, owner_user_id}` → the unit saves them and reboots → joins WiFi → connects MQTT → calls
  `POST /provisioning/claim-device` with its secret → the account owns it (≈5 s end to end).
- **Control.** App `PATCH /devices/:id/outputs/green` → backend publishes `output_set` → unit switches the pin and publishes its
  retained `state` → backend stores it and pushes `device_state` over the WebSocket (≈0.3 s round trip). Commands to an
  offline unit are refused with HTTP 409.
- **Alarm.** Radar presence goes high (stable 200 ms) while armed → buzzer on **immediately, on the unit** → `sensor_trigger` +
  state published → the app plays its alarm tone and shows a notification with Stop → Stop silences it, the unit stays armed.
- **Online / offline.** Backend pings every unit every 5 s, the unit answers with a heartbeat; 15 s of silence = Offline
  (pushed to the app). Measured on hardware with the power cut: Offline after 13 s, Online again 4 s after power returned.
- **Remove a unit.** `DELETE /devices/:id` unclaims it, sets `reset_pending` and nudges the unit (`sync`); the unit asks
  `POST /provisioning/status` with its secret and, only if told to, factory-resets itself back into setup mode (≈5 s). A unit that
  was offline resets the moment it comes back.

## Behaviour you can rely on

| What | Value |
|---|---|
| Backend ping / online check / offline threshold | every 5 s / every 1 s / 15 s without a message |
| WebSocket keep-alive / app reconnects after silence | every 20 s / 60 s |
| Unit heartbeat | on connect, every 30 s, and as the answer to each ping |
| Unit WiFi retry (after it has joined once) | every 20 s, forever |
| Unit MQTT retry | 3 s, doubling to 30 s; each attempt blocks the unit for at most 4 s |
| Unit claim retry | every 5 s five times, then every 30 s, forever |
| Local alarm | new presence while armed → buzzer on immediately; off 5 s after presence clears |
| Setup-mode WiFi scan (for the app's "can the unit see this network" check) | every 5 minutes, only while nobody is connected |
| Add Device waits for the unit to appear | up to 60 s |

| Status LED | Meaning |
|---|---|
| slow blink | setup hotspot is up, waiting for the app |
| solid | online |
| fast blink | online but the server rejected the unit (unknown id/secret — hold BOOT 5 s or re-flash) |
| off | offline |

**If something breaks:** a router outage, no internet, or a broker restart should each recover by themselves (the unit keeps
retrying and the alarm keeps working locally) — see "What's verified" for which of these have actually been tested.

## API reference (summary)

**REST** (`http://<host>:4000`; `Bearer` = token from `/auth/register` or `/auth/login`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | `{ok, mqtt}` — `mqtt` is the backend's own link to the broker |
| `POST /auth/register` · `/auth/login` · `/auth/logout` | — / Bearer | name + phone (**no OTP**) → token |
| `GET /me` · `PATCH /me/settings` | Bearer | profile, alert tone |
| `GET/POST /me/wifi-networks` · `PATCH/DELETE /me/wifi-networks/:id` | Bearer | saved 2.4 GHz networks (8–63 char password, or empty) |
| `GET /devices` · `GET /devices/:id` · `PATCH /devices/:id` | Bearer | list, one unit (with `online`), rename |
| `PATCH /devices/:id/outputs/:output` | Bearer | `green` `yellow` `red` `buzzer` — 409 if offline |
| `PATCH /devices/:id/alert-mode` | Bearer | arm / disarm — 409 if offline |
| `PATCH /devices/:id/radar` | Bearer | range, delay, sensitivity, close-range threshold |
| `POST /devices/:id/alarm/stop` | Bearer | silence, stay armed |
| `GET /devices/:id/events` | Bearer | recent detections |
| `DELETE /devices/:id` | Bearer | unclaim **and reset the unit** |
| `POST /manufacturing/register-device` | `X-Manufacturing-Key` | new unit → `{device_id, device_secret}` |
| `POST /provisioning/claim-device` · `/status` · `/reset-device` | `device_secret` | called by the unit itself |

**Unit local HTTP** (setup hotspot only, `192.168.4.1`): `GET /info`, `POST /provision {ssid, password, owner_user_id}`.

**MQTT** (`devices/<id>/…`): `commands` ← `output_set`, `alert_mode_set`, `alarm_stop`, `radar_config`, `ping`, `sync` ·
`state` (retained) → green/yellow/red/buzzer/alarm/presence/alert_mode_active/radar_ok/target_cm · `events` → `sensor_trigger`,
`heartbeat`, `radar_info`, `radar_config_result`.

**WebSocket** (`/ws?token=…`): `device_state`, `device_status`, `sensor_event`, `radar_info`, `radar_config_result`,
`device_removed`, `hb`.

## Data model (schema v4)

`users` (name, unique phone, settings) · `sessions` (SHA-256 of each token) · `wifi_networks` (per user, **password in plain
text**) · `devices` (id, secret, owner, name, status, `wifi_ssid`, `last_seen`, lamp/buzzer/alarm/presence state, radar settings,
`reset_pending`) · `sensor_events`. `PRAGMA user_version` holds the schema version; **bumping `SCHEMA_VERSION` in `db.js`
drops every table** (the documented way to wipe production — all units must then be re-flashed). Details in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Setting up the project (prototype 2)

All commands are for a Mac. `app/`, `firmware/`, `tools/` and `simulator/` exist only in the maintainer's
local working tree (they are gitignored), so the flashing and app steps need that copy; the backend steps
work from a plain clone of this repo.

### 1. What you need

| Tool | Used for |
|---|---|
| Node.js 20+ and npm | backend, `tools/`, simulator |
| Docker | the production backend on EC2 (not needed for local development) |
| Mosquitto (`brew install mosquitto`) | local MQTT broker |
| PlatformIO | building and flashing the ESP32; the flash script uses its own copy in `firmware/.pio-venv` |
| Flutter SDK + Android SDK | building the Android app |
| An ESP32 DevKit and a USB **data** cable (not a charge-only one) | one unit |

One-time PlatformIO setup. The first build then downloads the ESP32 toolchain (several hundred MB):
```bash
python3 -m venv firmware/.pio-venv
firmware/.pio-venv/bin/pip install platformio
```

### 2. Wire a unit

| Part | ESP32 pin | Notes |
|---|---|---|
| Radar VCC / GND | 3V3 / GND | Ai-Thinker Rd-03L_V2 |
| Radar OT2 | D4 (GPIO4) | digital output, HIGH while it sees someone |
| Radar TXD (OT1) → ESP32 | D26 | the firmware also accepts TX on D25 (it tries both pin orders and both 115200/256000 baud and remembers the one that answers) |
| Radar RXD ← ESP32 | D25 | |
| Traffic light green / yellow / red | D18 / D19 / D21 | HIGH = lit |
| Active buzzer | D22 | HIGH = sounding |
| BOOT button (on the board) | GPIO0 | hold 5 s = factory reset |

The serial link is only needed for the radar settings in the app; presence detection works from OT2 alone.

### 3. Run the backend

**Production** is a Docker Compose stack on EC2 that redeploys on every push to `main` — see
[DEPLOYMENT.md](DEPLOYMENT.md) for the server, CI/CD, and operations.

**Local development:**
```bash
/opt/homebrew/opt/mosquitto/sbin/mosquitto -c mosquitto/mosquitto.conf -d   # broker on :1883
cd backend && cp .env.example .env && npm install && npm run dev            # API on :4000
```
`backend/.env` holds `MANUFACTURING_KEY`, the secret that lets `tools/flash-device.sh` register new units.

### 4. Flash a new unit — `tools/flash-device.sh`

Plug the board in over USB and run:
```bash
tools/flash-device.sh                       # production backend (the default)
tools/flash-device.sh --backend-url http://192.168.1.20:4000   # your local backend: use the Mac's LAN IP
tools/flash-device.sh --port /dev/cu.usbserial-0001            # if more than one board is plugged in
```

| Option | Meaning |
|---|---|
| `--backend-url` | backend the unit registers with and later talks to. Defaults to the production server. `127.0.0.1`/`localhost` are rejected — the board can't reach them |
| `--port` | serial port. Without it the script picks the first `/dev/cu.usbserial*`, `/dev/cu.SLAB_USBtoUART*` or `/dev/cu.wchusbserial*` |
| `--host` | MQTT/HTTP host for the unit if it differs from the one in `--backend-url` |

**Manufacturing key.** The script asks for it (typing is hidden), or read it from the environment:
`MANUFACTURING_KEY=... tools/flash-device.sh`. It must equal `MANUFACTURING_KEY` in the target backend's
`.env` (for a local backend started without a `.env` it is `dev-manufacturing-key`). Never commit it.

**What the script does:**
0. Checks from this Mac that the backend (`/health`) and the MQTT port answer, and refuses to flash if they don't — a unit flashed against an address that can't be reached never connects. It warns when the address is a private LAN IP (that unit only works on that network).
1. Finds the board's serial port.
2. Registers a brand-new unit with the backend (`tools/provision-device.js`, running `npm install` in `tools/` first if needed), which returns a `device_id` and `device_secret`.
3. Writes them, plus the backend address, to `firmware/include/secrets.h` (gitignored — never edit it by hand).
4. Erases the board's flash, so no WiFi or owner from an earlier flash survives.
5. Compiles the firmware and uploads it. It also appends a line to `tools/flashed-devices.csv`.
6. Resets the board and reads its boot log to confirm it came up and is hosting its setup hotspot.

Every run creates a **new identity**. Run it once per physical board, not to update code (see below). When it
finishes, the unit hosts an open WiFi hotspot called `SECURE-<device_id>` and blinks its status LED slowly,
waiting for the app.

**Updating the firmware on a unit that is already set up** (keeps its identity, saved WiFi and owner):
```bash
cd firmware && .pio-venv/bin/pio run -e esp32dev -t upload --upload-port /dev/cu.usbserial-0001
.pio-venv/bin/pio device monitor -b 115200 --port /dev/cu.usbserial-0001   # serial log; Ctrl+C before flashing again
```

### 5. Add the unit in the app

1. Install the APK from the link at the top (Android only — iOS can't scan for WiFi networks).
2. Sign up with a name and phone number (no OTP), then save your home WiFi in the app. It must be a **2.4 GHz** network; the ESP32
   can't join 5 GHz. When you tap Save, the phone briefly joins the network with the password you typed, so a wrong password is
   caught immediately (Android asks you to tap **Connect** once; "Save anyway" is offered if the network is out of the phone's range).
3. **Add device**: the app finds the `SECURE-<device_id>` hotspot, joins it, and hands the unit your WiFi and account. The unit reboots
   onto your WiFi and claims itself.
4. **Remove a unit**: the trash icon removes it from your account **and resets it**, so it shows up under Add Device again — right
   away if it is online, or as soon as it is back online. (Units flashed before 2026-11-01 ignore this and still need the BOOT button.)

Status LED on the unit: slow blink = setup hotspot is up, solid = online, **fast blink = online but the server rejected the unit**
(see Troubleshooting), off = offline. In the app each unit shows an **Online / Offline** badge: the backend checks
every unit every 5 s, so an unplugged unit shows Offline within about 15 seconds, and a unit that lost WiFi keeps
retrying the saved network by itself and goes back to Online once it's in. You can also hold the BOOT button
for 5 seconds to factory-reset a unit: it forgets its WiFi and owner, returns the radar to its default range
(8.4 m), delay (30 s) and thresholds, and shows up in setup mode again.

### 6. Tune the radar (in the app, per unit)

| Setting | What it does |
|---|---|
| Detection range | ignores anything farther away (0.7 m steps, up to 8.4 m) |
| Sensitivity | shifts the threshold of every distance zone, −30 to +20 dB. Lower = reacts to weaker movement |
| Close-range threshold | threshold of the two nearest zones (0–1.4 m) on their own. The radar's own signal can show up there as a constant "someone is there"; raise it until that stops (about 60 dB on the test unit), or lower it to pick up a hand a few centimetres from the sensor. "Default" leaves the radar's own value |
| No-person delay | how long the area must stay empty before it reports "No one there" (10–120 s) |

**Save to radar** sends the values to the unit, which writes them to the radar's flash. The radar stops
detecting for a moment while it is being written to.

### 7. Build the Android app

```bash
cd app && flutter pub get
flutter run                       # on a connected Android phone
flutter build apk --release       # build/app/outputs/flutter-apk/app-release.apk
```
The backend address the app talks to is compiled in from `app/lib/config.dart`. To publish a new APK on GitHub
Releases, follow "Android app download" in [DEPLOYMENT.md](DEPLOYMENT.md).

### 8. Run without hardware (simulator)

```bash
cd tools && npm install && node provision-device.js   # prints device_id + device_secret
cd simulator && npm install
DEVICE_ID=<device_id> DEVICE_SECRET=<device_secret> OWNER_USER_ID=<your app user id> \
  BACKEND_HTTP_URL=http://127.0.0.1:4000 npm start     # Enter toggles presence; AUTO_TOGGLE_MS=15000 does it on a timer
```

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "No ESP32 USB-serial device found" | charge-only cable, or the board isn't recognised; try another cable, or pass `--port` (`ls /dev/cu.*` shows what is plugged in) |
| Upload stops at "Connecting......" or fails with "multiple access on port?" | another program has the serial port — close any serial monitor or logger (`lsof /dev/cu.usbserial-0001`), then retry. If it still can't connect, hold the board's BOOT button as the upload starts |
| The board reboots every ~2 seconds while a logger is attached | two programs are reading the port; the second one's reconnect pulses the reset line. Keep exactly one reader open |
| `[provision] failed: 403` | the manufacturing key doesn't match the target backend's `.env` |
| "isn't answering" / "MQTT broker ... isn't reachable" at step 0 | the backend or broker can't be reached from this Mac: for production check the EC2 instance and the security group (ports 4000 and 1883, see DEPLOYMENT.md); for a local backend start it first |
| The script refuses `127.0.0.1` | give `--backend-url` the Mac's LAN IP (local backend) or the server's public IP |
| The app says the unit "hasn't checked in yet" and the unit's light blinks fast | the unit joined your WiFi (so the password is fine) but the server rejected it: unknown device (it was flashed before a database reset or against another backend) or wrong owner. Hold BOOT for 5 s; if it still blinks fast, re-flash it with `tools/flash-device.sh` |
| A unit's hotspot never appears in the app | it is already set up or offline — hold BOOT for 5 s to reset it; check the 2.4 GHz WiFi rule above |
| The app says the radar isn't connected | the radar's TXD/RXD wires to D26/D25 (see the wiring table); presence still works from OT2 |
| The app says someone is there when the room is empty | raise **Close-range threshold** (about 60 dB), then lower the range or raise sensitivity if it persists |
| A flashed unit is rejected after the database was reset | a schema bump (see DEPLOYMENT.md → Database) deletes every registered unit; run `tools/flash-device.sh` again |
| The app says "No nearby devices found yet" but the unit's light blinks slowly | Android rate-limits the app's WiFi scan. Wait a minute and press Search again |
| "Couldn't join SECURE-…" while adding a unit | try again — the unit's periodic WiFi scan (every 5 min) can interrupt a phone that is connecting at that moment |
| "Couldn't join "<network>" with that password" when saving a WiFi network | the password is wrong, or the network is out of the phone's range; "Save anyway" skips the check |
| A unit shows Offline although it is plugged in | it can't reach your 2.4 GHz WiFi or the internet; it retries every 20 s by itself. Check `curl http://<host>:4000/health` shows `"mqtt":true` |
| Removing a unit in the app didn't make it reappear under Add Device | the unit runs firmware from before 2026-11-01 (it ignores the reset). Hold BOOT for 5 s once, or re-flash it |

## What's verified (prototype 2)

Last full run: **2026-11-01**, against the **production** backend on EC2, a real ESP32 unit, a real Pixel phone and Chrome.

**On real hardware / production**
- Fresh start: database wiped (schema v4) → test account created in the app (Chrome) → `tools/flash-device.sh` registers, erases and
  flashes a new unit and confirms it boots → the phone adds it (WiFi handover, MQTT, claim in ≈5 s) → Online on the phone and in Chrome.
- All three lamps, the buzzer and alert mode switched through the API: **10 of 10 confirmed by the unit in 0.24–0.34 s**. A lamp
  toggled from Chrome reached the real unit.
- Power cut (board held in reset): **Offline after 13.1 s** (was 44 s with the earlier 45 s threshold), **Online again 4.4 s** after
  power returned, with no re-setup. Chrome flipped by itself through the WebSocket.
- Removing the unit in the app: the unit reset itself and was back in setup mode in ≈5 s, reappeared under Add Device, was added
  again and came back Online.
- WiFi password check: a wrong password was refused and not saved; the right one was accepted (an earlier version of this check
  verified nothing — see "Known gaps" for the pitfall).
- App v2.2.0 built and published as a GitHub Release; GitHub's stored SHA-256 matches the local build.

**Locally, with a fake unit** (throwaway broker and database): online/offline timing and recovery, no stale alarm after a backend
restart, WebSocket keep-alive, and the whole remove-and-reset flow including a unit that was offline at deletion and a stale flag
that must never reset a re-added unit.

**Not yet exercised:** a router outage, an internet outage, a restart of the production broker, a factory reset while the unit is
offline, a wrong WiFi password reaching the unit, a 5 GHz-only network, and any long soak test.

## Known gaps

- **Security (prototype shortcuts, must be fixed before real users):** login is name + phone with **no OTP** and sessions never
  expire; **no TLS** on HTTP, MQTT or WebSocket; saved WiFi passwords are **plain text** in SQLite and travel over HTTP; the broker is
  **anonymous and public**, so anyone who knows a `device_id` can publish control commands (identity/reset changes are protected,
  control is not); no database backups; single instance.
- **No schedule:** alert mode is armed and disarmed manually (it survives a power cut); there is no timed alert window yet.
- **iOS:** Add Device cannot work on iOS (Apple gives apps no WiFi scanning); the iOS build is unverified.
- **No OTA firmware updates**, and push is a WebSocket stand-in for FCM, so swiping the app away stops alerts.
- **Android quirks:** the app's WiFi scan is rate-limited by Android (if "No nearby devices found" shows while the unit's hotspot
  is up, wait a minute and press Search again); an Add can fail once with "Couldn't join SECURE-…" if it lands on the unit's
  periodic scan — just try again.
- **Pitfall worth remembering:** the `wifi_iot` plugin only truly tests a WiFi password with `withInternet: false`; with `true`
  it registers a network *suggestion* and reports success without checking anything.

## Deploying to EC2

The backend runs on AWS EC2 with Docker Compose and auto-deploys on every push to `main`.
See [DEPLOYMENT.md](DEPLOYMENT.md) for the server details, CI/CD, operations, and troubleshooting.

**One-time setup for a fresh instance:**
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

sudo mkdir -p /opt/home-security && sudo chown $USER /opt/home-security
git clone https://github.com/Hyzen09/Home-security.git /opt/home-security
cd /opt/home-security/backend && cp .env.example .env
# edit .env: set a real MANUFACTURING_KEY, e.g. `openssl rand -hex 32`

cd /opt/home-security
docker compose -f docker-compose.prod.yml up -d --build
curl http://localhost:4000/health
```

---

# History — prototype 1 (kept for reference, no longer current)

Everything below describes the **first prototype** (ESP8266 NodeMCU, 2 relays + hooter + PIR, schema v1) and is kept only as
history. Several statements there are out of date — for example the ESP32 firmware **has since been flashed and run on real
hardware** — so use the sections above for anything current.

## Running it yourself (prototype 1)

```bash
# 1. MQTT broker (prototype: no TLS/auth, see mosquitto/mosquitto.conf)
/opt/homebrew/opt/mosquitto/sbin/mosquitto -c mosquitto/mosquitto.conf -d

# 2. Backend
cd backend && npm install && npm run dev   # http://localhost:4000
```

From here you can exercise the system two ways:

**A. No hardware — software simulator** (fastest, what Playwright testing uses):
```bash
cd tools && npm install
node provision-device.js                  # prints device_id + device_secret

# Register in the app first (step 3 below) to get a real user_id, then:
cd simulator && npm install
DEVICE_ID=<device_id> DEVICE_SECRET=<device_secret> OWNER_USER_ID=<user_id> \
  BACKEND_HTTP_URL=http://127.0.0.1:4000 npm start
# (add AUTO_TRIGGER_MS=15000 to fire the PIR on a timer; omit it and press
#  Enter to fire it manually instead)
```

**B. Real hardware** (verified working — see `firmware-esp8266-bench/README.md`):
```bash
# with an ESP8266 (NodeMCU V3) connected over USB:
tools/flash-device.sh
# registers a device, writes secrets.h, erases flash, and flashes the board —
# it boots its own "SECURE-<device_id>" hotspot, ready for the app to find
```

```bash
# 3. App
cd app && flutter pub get
flutter run -d chrome          # or: flutter run (lists Android/iOS/other devices)
```

Register in the app with any name/phone — you're logged in immediately, no OTP.
You'll then be asked for your home WiFi name/password (saved only on this
device/browser) before reaching the dashboard. The "Add Device" nearby-search flow
needs a real **Android** device (WiFi scan/join isn't available in a browser or on
iOS — see below); for software-only testing, use the simulator's `OWNER_USER_ID`
self-claim shortcut above instead and the unit just appears on the dashboard.

## What was verified in prototype 1

### Software-only, via the real Flutter UI (Chrome, Playwright), against the real
backend, over a real MQTT broker, to real device-simulator processes:

- Register (name + phone, no OTP) → session persisted (survives reload)
- WiFi-details screen shown once after registration, saved locally, dashboard
  reached afterward
- A simulator unit self-claims to the registered account on startup and appears
  on the dashboard with no pairing step
- Toggle Alert Mode / Relay 1 / Relay 2 → command reaches the simulator over MQTT
  → simulator actuates → state flows back → UI updates
- Simulated PIR trigger with alert mode active → hooter sounds locally and
  instantly in the simulator (no cloud round-trip) → event also reaches the
  backend → app shows "SOUNDING" + logs the trigger in "Recent Alerts" → auto-
  silences after 5s
- The backend does not crash on a message from an unknown/stale device_id
- Removing a device from the dashboard unclaims it (not a hard delete — its
  `device_secret` survives so it can be re-provisioned later)

### On real hardware — an actual flashed ESP8266 board and a real Android phone
(Pixel), driven end-to-end against the real backend over the real home WiFi:

- `tools/flash-device.sh` registers a device, erases the board's flash (so stale
  config from a previous flash can't bleed through), and flashes it for real via
  `esptool.py`
- The freshly-flashed board boots its own `SECURE-<device_id>` WiFi hotspot
- The Android app's real WiFi scan finds it, joins it (`WifiNetworkSpecifier`,
  with the system "Connect to this network?" dialog), and POSTs the saved home
  WiFi credentials + account id directly to the unit's local `/info`/`/provision`
  endpoints
- The unit joins home WiFi for real, self-claims to the backend over a real HTTP
  call, and appears on the dashboard automatically
- Toggling Alert Mode / a relay from the app reaches the **physical board** over
  MQTT and is acknowledged back
- Pressing the board's physical button (PIR stand-in) with alert mode armed:
  the unit sounds its own onboard LED (hooter stand-in, since this bench board
  has no buzzer) **locally and instantly**, publishes the trigger event, and the
  phone shows "SOUNDING" + logs the alert, live, over a reconnecting WebSocket
- The phone plays a real, audible, looping alarm sound (confirmed via
  `dumpsys audio`: `usage=USAGE_ALARM`, unmuted, routed to the built-in speaker)
  that starts and stops in sync with the real board's hooter state, including
  the real 5-second auto-silence
- The WebSocket auto-reconnects after a drop (found during this testing — it
  previously had no reconnect logic at all) and re-syncs device state on
  reconnect

`flutter analyze` is clean and the widget test (`app/test/widget_test.dart`) passes.
