import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { spotifyRouter } from "./routes/spotify.js";
import { iceServersRouter } from "./routes/iceServers.js";
import { registerRoomHandlers } from "./sockets/roomHandlers.js";
import { registerSignalingHandlers } from "./sockets/signalingHandlers.js";
import { registerQueueHandlers } from "./sockets/queueHandlers.js";

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/spotify", spotifyRouter);
app.use("/api/ice-servers", iceServersRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

io.on("connection", (socket) => {
  registerRoomHandlers(io, socket);
  registerSignalingHandlers(io, socket);
  registerQueueHandlers(io, socket);
});

httpServer.listen(PORT, () => {
  console.log(`listen-together server running on http://localhost:${PORT}`);
});
