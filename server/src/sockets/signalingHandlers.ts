import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";

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
    const room = roomStore.setSharing(code, false);
    if (room) io.to(code).emit("room:state", room);
  });
}
