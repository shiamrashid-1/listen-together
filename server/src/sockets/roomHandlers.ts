import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";
import * as tokenStore from "../spotify/tokenStore.js";
import * as playbackPoller from "../spotify/playbackPoller.js";
import * as audioRelay from "../audio/audioRelay.js";

export function registerRoomHandlers(io: Server, socket: Socket) {
  socket.on(
    "room:create",
    ({ name, clientId }: { name: string; clientId?: string }, callback: (res: { ok: true; room: ReturnType<typeof roomStore.createRoom> } | { ok: false; error: string }) => void) => {
      const cleanName = (name ?? "").trim().slice(0, 30) || "Host";
      const room = roomStore.createRoom(socket.id, cleanName, clientId);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.name = cleanName;
      callback({ ok: true, room });
    }
  );

  socket.on(
    "room:join",
    ({ code, name, clientId }: { code: string; name: string; clientId?: string }, callback: (res: { ok: true; room: ReturnType<typeof roomStore.getRoom> } | { ok: false; error: string }) => void) => {
      const cleanName = (name ?? "").trim().slice(0, 30) || "Guest";
      const room = roomStore.joinRoom(code, socket.id, cleanName, clientId);
      if (!room) {
        callback({ ok: false, error: "Room not found. Double-check the code and try again." });
        return;
      }
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.name = cleanName;
      callback({ ok: true, room });
      socket.to(room.code).emit("room:state", room);
      socket.to(room.code).emit("room:participant-joined", { id: socket.id, name: cleanName });
    }
  );

  socket.on("disconnect", () => {
    // Don't act on this immediately - it might just be a network blip, and
    // `room:join` will reclaim the slot (via clientId) if the same tab
    // reconnects within the grace period. `onFinalize` only runs if that
    // doesn't happen, i.e. this was a genuine departure.
    roomStore.scheduleParticipantRemoval(socket.id, (result) => {
      if (result.deleted) {
        tokenStore.clear(result.room.code);
        playbackPoller.stopPolling(result.room.code);
        audioRelay.stopRelay(result.room.code);
        return;
      }

      if (result.hostChanged) {
        // The new host hasn't authorized anything — don't carry over the
        // previous host's Spotify connection or audio relay.
        tokenStore.clear(result.room.code);
        playbackPoller.stopPolling(result.room.code);
        audioRelay.stopRelay(result.room.code);
        const updated = roomStore.setSpotifyConnected(result.room.code, false);
        if (updated) {
          io.to(updated.code).emit("room:state", updated);
          return;
        }
      }

      io.to(result.room.code).emit("room:state", result.room);
    });
  });
}
