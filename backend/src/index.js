import express from "express";
import cors from "cors";
import http from "http";

import "./mqtt.js"; // connects to the broker and starts handling device messages
import { initWs } from "./ws.js";
import { requireAuth } from "./auth-middleware.js";

import authRoutes from "./routes/auth.js";
import deviceRoutes from "./routes/devices.js";
import manufacturingRoutes from "./routes/manufacturing.js";
import provisioningRoutes from "./routes/provisioning.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/devices", requireAuth, deviceRoutes);
app.use("/manufacturing", manufacturingRoutes);
// Not user-authed: the device itself calls this with its own device_secret
// (see routes/provisioning.js), not a bearer token.
app.use("/provisioning", provisioningRoutes);

const server = http.createServer(app);
initWs(server);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[http] backend listening on http://0.0.0.0:${PORT}`);
});
