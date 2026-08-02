import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";

export function registerRoomHandlers(io: Server, socket: Socket) {
  socket.on("room:create", ({ name }: { name: string }, callback: (res: { ok: true; room: ReturnType<typeof roomStore.createRoom> } | { ok: false; error: string }) => void) => {
    const cleanName = (name ?? "").trim().slice(0, 30) || "Host";
    const room = roomStore.createRoom(socket.id, cleanName);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.name = cleanName;
    callback({ ok: true, room });
  });

  socket.on(
    "room:join",
    ({ code, name }: { code: string; name: string }, callback: (res: { ok: true; room: ReturnType<typeof roomStore.getRoom> } | { ok: false; error: string }) => void) => {
      const cleanName = (name ?? "").trim().slice(0, 30) || "Guest";
      const room = roomStore.joinRoom(code, socket.id, cleanName);
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
    const result = roomStore.removeParticipant(socket.id);
    if (!result || result.deleted) return;
    io.to(result.room.code).emit("room:state", result.room);
  });
}
