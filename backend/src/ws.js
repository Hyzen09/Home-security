import { WebSocketServer } from "ws";
import { userForToken } from "./sessions.js";

// Prototype stand-in for FCM push: app clients open a WebSocket and get
// live JSON events (sensor triggers, device state changes).
// Real product replaces this with FCM so alerts work when the app isn't open.

let wss = null;
const clientsByUser = new Map(); // user_id -> Set<ws>

// A WebSocket whose path died silently (phone changed network, NAT or carrier
// dropped the idle mapping) never reports an error, so the app would keep
// believing it is connected and miss alarms. Every HEARTBEAT_MS the server
//  - pings each socket and terminates the ones that didn't answer the last ping
//    (frees dead entries; browsers and Dart answer pings by themselves), and
//  - sends {type:"hb"} so the app can tell "connected but quiet" from "dead":
//    it reconnects when it has heard nothing for a few intervals.
export const WS_HEARTBEAT_MS = 20_000;

export function initWs(server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "hb" }));
    }
  }, WS_HEARTBEAT_MS);
  heartbeat.unref();

  wss.on("connection", (socket, req) => {
    socket.isAlive = true;
    socket.on("pong", () => (socket.isAlive = true));
    socket.on("error", () => {}); // a reset connection also fires "close", which cleans up
    const url = new URL(req.url, "http://localhost");
    const user = userForToken(url.searchParams.get("token"));
    if (!user) {
      socket.close(4001, "valid token query param required");
      return;
    }
    const userId = user.id;
    if (!clientsByUser.has(userId)) clientsByUser.set(userId, new Set());
    clientsByUser.get(userId).add(socket);
    console.log(`[ws] client connected user=${userId}`);

    socket.on("close", () => {
      clientsByUser.get(userId)?.delete(socket);
      console.log(`[ws] client disconnected user=${userId}`);
    });
  });
}

export function pushToUser(userId, event) {
  const sockets = clientsByUser.get(userId);
  if (!sockets || sockets.size === 0) return;
  const payload = JSON.stringify(event);
  for (const s of sockets) {
    if (s.readyState === 1) s.send(payload);
  }
}
