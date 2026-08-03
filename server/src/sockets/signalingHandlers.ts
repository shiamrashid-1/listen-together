import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";
import * as audioRelay from "../audio/audioRelay.js";

/**
 * Pure relay for WebRTC mesh signaling and audio-sharing lifecycle events.
 * The server never inspects SDP/ICE payloads - it just forwards them to the
 * targeted socket, tagging the sender so the recipient knows who it's from.
 */
export function registerSignalingHandlers(io: Server, socket: Socket) {
  socket.on("webrtc:offer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    io.to(to).emit("webrtc:offer", { from: socket.id, sdp });
  });

  socket.on("webrtc:answer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    io.to(to).emit("webrtc:answer", { from: socket.id, sdp });
  });

  socket.on("webrtc:ice-candidate", ({ to, candidate }: { to: string; candidate: unknown }) => {
    io.to(to).emit("webrtc:ice-candidate", { from: socket.id, candidate });
  });

  socket.on("audio:sharing-started", () => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    const room = roomStore.setSharing(code, true);
    if (room) io.to(code).emit("room:state", room);
  });

  socket.on("audio:sharing-stopped", () => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    audioRelay.stopRelay(code);
    const room = roomStore.setSharing(code, false);
    if (room) io.to(code).emit("room:state", room);
  });

  // Fallback path for listeners whose network can't establish a WebRTC
  // connection at all (e.g. locked-down proxied networks). The host streams
  // the same captured audio here as recorded webm/opus chunks, which get
  // transcoded server-side into a continuous MP3 stream (see audioRelay.ts)
  // - always-on alongside WebRTC so the fallback is instantly available if/
  // when a listener needs it.
  socket.on("audio:chunk", (chunk: ArrayBuffer) => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    audioRelay.pushChunk(code, Buffer.from(chunk));
  });

  // Some networks block long-lived streaming HTTP connections outright even
  // though the WebSocket transport carrying this very event works fine (it's
  // the same connection powering room state/chat/signaling). For listeners
  // whose WebRTC connection fails, this delivers the relay's MP3 output as
  // binary chunks over that already-proven connection instead.
  socket.on("audio:relay-subscribe", () => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    stopRelayChunks(socket);
    socket.data.audioRelayUnsubscribe = audioRelay.onChunk(code, (chunk) => {
      socket.emit("audio:relay-chunk", chunk);
    });
  });

  socket.on("audio:relay-unsubscribe", () => stopRelayChunks(socket));
  socket.on("disconnect", () => stopRelayChunks(socket));
}

function stopRelayChunks(socket: Socket) {
  const unsubscribe = socket.data.audioRelayUnsubscribe as (() => void) | undefined;
  unsubscribe?.();
  socket.data.audioRelayUnsubscribe = undefined;
}
