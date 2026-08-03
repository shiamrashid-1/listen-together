import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { spotifyRouter } from "./routes/spotify.js";
import { createSpotifyAuthRouter } from "./routes/spotifyAuth.js";
import { iceServersRouter } from "./routes/iceServers.js";
import { audioRelayRouter } from "./routes/audioRelay.js";
import { registerRoomHandlers } from "./sockets/roomHandlers.js";
import { registerSignalingHandlers } from "./sockets/signalingHandlers.js";
import { registerQueueHandlers } from "./sockets/queueHandlers.js";
import { registerChatHandlers } from "./sockets/chatHandlers.js";
import { onQueueAdvance } from "./rooms/roomStore.js";

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/spotify", spotifyRouter);
app.use("/api/ice-servers", iceServersRouter);
app.use("/api/audio", audioRelayRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

// Mounted after `io` exists because the OAuth callback needs to broadcast
// the updated room state once the host finishes connecting Spotify.
app.use("/api/spotify", createSpotifyAuthRouter(io));

// The queue auto-advances tracks on its own timers (not in response to any
// socket event), so it needs a way to broadcast those changes to the room.
onQueueAdvance((state) => io.to(state.code).emit("room:state", state));

io.on("connection", (socket) => {
  registerRoomHandlers(io, socket);
  registerSignalingHandlers(io, socket);
  registerQueueHandlers(io, socket);
  registerChatHandlers(io, socket);
});

httpServer.listen(PORT, () => {
  console.log(`listen-together server running on http://localhost:${PORT}`);
});
