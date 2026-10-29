import { WebSocketServer } from "ws";

// Prototype stand-in for FCM push: app clients open a WebSocket and get
// live JSON events (sensor triggers, device state changes).
// Real product replaces this with FCM so alerts work when the app isn't open.

let wss = null;
const clientsByUser = new Map(); // user_id -> Set<ws>

export function initWs(server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const userId = url.searchParams.get("user_id");
    if (!userId) {
      socket.close(4000, "user_id query param required");
      return;
    }
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
