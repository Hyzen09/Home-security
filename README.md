# IoT Home Security — Prototype

**Android app:** [download the latest APK](https://github.com/Hyzen09/Home-security/releases/latest/download/home-security.apk)
(all versions on the [Releases](https://github.com/Hyzen09/Home-security/releases) page).

> **Prototype 2 (current):** each unit is an ESP32 DevKit with an Ai-Thinker Rd-03L_V2 24 GHz radar
> (OT2 → D4), a traffic light (green D18, yellow D19, red D21) and a buzzer (D22), all controlled from
> the app; the BOOT button (hold 5 s) factory-resets it. Accounts keep multiple saved WiFi networks
> (2.4 GHz only) and each unit is assigned one when added. Server-side details are in
> [DEPLOYMENT.md](DEPLOYMENT.md). The sections below describe prototype 1 (ESP8266, relays + hooter)
> and are kept as history.

> **Repo scope:** this repository tracks only the **server-side components** —
> `backend/`, `mosquitto/`, `docker-compose.yml` — of the larger prototype
> described below. The Flutter app and ESP32/ESP8266 firmware are developed
> in the same local working tree but are intentionally not part of this repo.

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
2. Sign up with a name and phone number (no OTP), then save your home WiFi in the app. It must be a **2.4 GHz** network; the ESP32 can't join 5 GHz.
3. **Add device**: the app finds the `SECURE-<device_id>` hotspot, joins it, and hands the unit your WiFi and account. The unit reboots onto your WiFi and claims itself.

Status LED on the unit: slow blink = setup hotspot is up, solid = online, **fast blink = online but the server rejected the unit**
(see Troubleshooting), off = offline. In the app each unit shows an **Online / Offline** badge: the backend checks
every unit every 5 s, so an unplugged unit shows Offline within about 15 seconds, and a unit that lost WiFi keeps
retrying the saved network by itself and goes back to Online once it's in. Hold the BOOT button
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

---

*Everything below this line is the original prototype 1 write-up (ESP8266, relays + hooter), kept as history.*

Working prototype of the system described in [system_architecture.md](system_architecture.md).
The core loop (device → cloud → app, and app → cloud → device) has been verified **two
ways**: through the real Flutter UI against the real backend with no hardware involved
(Playwright/Chrome), and — for the first time — on **real physical hardware**: a flashed
ESP8266-class board talking to the real backend over a real home WiFi network, discovered
and provisioned by a real Android phone, with a real audible alarm. See "What's actually
verified" below for exactly what that means.

**Major hardware/flow correction, live in this prototype:** there is no payment gateway,
wallet, or billing anywhere; **every unit is identical and self-contained** — 2 relays + 1
hooter + 1 sensor each, no hub/sensor split, no pairing step; login is **name + phone, no
OTP**; a freshly-flashed unit boots its own WiFi hotspot and is found by the app via
**WiFi-SSID scan, not a QR code**; the app asks for the home WiFi once, right after login,
and hands it to each new unit directly over that local hotspot. See
system_architecture.md §9 for the reasoning behind each change.

**[Documentation.html](Documentation.html)** is the maintained reference doc for this
project — architecture, protocol reference, tech stack, run instructions, and current
status in one page. Open it directly in a browser. It embeds
[system_architecture.svg](system_architecture.svg) (static topology) and
[flow.svg](flow.svg) (sequence diagrams); update those two together when the system changes.

## Tech stack

| Layer | Technology |
|---|---|
| Firmware — production target | ESP32, Arduino framework via PlatformIO, C++ — `firmware/` |
| Firmware — bench-test target (real hardware available during dev) | ESP8266 (NodeMCU V3), same Arduino/PlatformIO toolchain — `firmware-esp8266-bench/` |
| Firmware libraries | PubSubClient (MQTT), ArduinoJson, LittleFS (ESP8266) / Preferences (ESP32) for saved WiFi + claim state |
| Cloud backend | Node.js + Express (REST), `mqtt` (MQTT client), `better-sqlite3`, `ws` (WebSocket push) |
| MQTT broker | Eclipse Mosquitto |
| Mobile app | Flutter (Dart) — targets Android (verified on real hardware) and iOS (written, unverified — no Xcode available here) |
| App packages | Provider, `http`, `web_socket_channel`, `shared_preferences`, `wifi_scan`, `wifi_iot`, `network_info_plus` |
| Native platform code | Kotlin (`MainActivity.kt`, Android alarm sound), Swift (`AppDelegate.swift`, iOS alarm sound — unverified) |
| Provisioning tooling | Node.js CLI (`tools/provision-device.js`) + Bash (`tools/flash-device.sh`, drives `esptool.py` via PlatformIO for real flashing) |

## Components

| Dir | What it is | Status |
|---|---|---|
| `backend/` | Node/Express REST API + MQTT handling + SQLite + WebSocket push (no billing) | **Running, tested — against both the simulator and real hardware** |
| `simulator/` | Node script standing in for a unit — speaks the real MQTT protocol | **Running, tested** |
| `firmware/` | Real ESP32 Arduino/PlatformIO firmware, the production target | **Compiles clean** (RAM 15.2%, Flash 93.6%) — the toolchain download that stalled for most of this project's life finally finished. Still never run on real ESP32 hardware (none available), so pin assignments/polarity/on-chip behavior remain unverified. |
| `firmware-esp8266-bench/` | ESP8266 port of the same firmware/protocol, for the NodeMCU V3 board actually on hand | **Compiled, flashed, and verified end-to-end on real hardware** — see below |
| `tools/` | CLI stand-in for the `.exe` provisioning tool, plus a real flashing script | **Running, tested** — `provision-device.js` (registration) and `flash-device.sh` (erase + real flash via esptool.py) both exercised against real hardware |
| `app/` | Flutter app (onboarding, WiFi details, nearby-device discovery, dashboard, relay/alert-mode control, remove device) | **Verified on a real Android phone**; iOS is written but unverified (see below) |
| `mosquitto/`, `docker-compose.yml` | MQTT broker config. Broker is currently run natively via Homebrew, not Docker (Docker Desktop wasn't running) | **Running** |

## Running it yourself (prototype 1, history)

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

## What's actually verified (not just "should work")

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

## Deliberately not built yet / unverified

- **ESP32 production firmware (`firmware/`) compiles clean but has never run on
  real hardware** — no ESP32 board available. The `espressif32` toolchain
  download that stalled for most of this project (confirmed stuck, not just
  slow, across multiple earlier attempts) eventually finished; `pio run -e
  esp32dev` now succeeds (RAM 15.2%, Flash 93.6% — worth watching if more
  features get added, there isn't a lot of flash headroom left in the default
  partition scheme). A real compile bug (`mqtt.publish` passing `char*` where
  `uint8_t*` was expected) was found and fixed in this exact file via the
  ESP8266 build before this ESP32 compile ever succeeded. Pin assignments,
  relay polarity, and real on-chip behavior remain unverified until it's
  actually flashed and run on an ESP32.
- **Nearby-device discovery on iOS is not possible, by Apple's design** — not a
  gap to fill later. iOS doesn't expose WiFi scanning to any third-party app, so
  the "Add Device" flow is Android-only; the iOS fallback screen explains this
  rather than pretending it's coming soon.
- **iOS build entirely unverified** — this Mac's Xcode install is incomplete
  (`flutter build ios` fails before even reaching a compiler: no CocoaPods
  workspace generated). The native Swift alarm-sound implementation
  (`ios/Runner/AppDelegate.swift`) and `Info.plist` entries are written against
  Flutter's documented API for this project's template, but have never been
  compiled or run.
- **Real `.exe` provisioning tool for the ESP32 production target** —
  `tools/flash-device.sh` does real flashing, but only for the ESP8266 bench
  target; burning credentials into ESP32 NVS flash via the real tool is still
  outstanding.
- **TLS on MQTT and on the self-claim HTTP call, signed JWTs, OTA** — prototype
  broker and auth are intentionally wide open (see `mosquitto/mosquitto.conf`
  and `backend/src/auth-middleware.js` comments). Do not point this at a real
  network.
- **Real FCM push** — stood in with a WebSocket channel, isolated behind a
  single module (`backend/src/ws.js`) so swapping it for the real service later
  shouldn't touch anything else.

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
