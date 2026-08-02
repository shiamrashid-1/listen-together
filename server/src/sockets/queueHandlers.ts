import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";
import type { QueueTrack } from "../types.js";

export function registerQueueHandlers(io: Server, socket: Socket) {
  socket.on("queue:add", (track: Omit<QueueTrack, "id" | "addedBy">) => {
    const code = socket.data.roomCode as string | undefined;
    const name = socket.data.name as string | undefined;
    if (!code) return;
    const room = roomStore.addQueueTrack(code, { ...track, addedBy: name ?? "Someone" });
    if (room) io.to(code).emit("room:state", room);
  });

  socket.on("queue:remove", ({ trackId }: { trackId: string }) => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    const room = roomStore.removeQueueTrack(code, trackId);
    if (room) io.to(code).emit("room:state", room);
  });

  socket.on("queue:reorder", ({ orderedIds }: { orderedIds: string[] }) => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    const room = roomStore.reorderQueue(code, orderedIds);
    if (room) io.to(code).emit("room:state", room);
  });

  socket.on("queue:mark-playing", ({ trackId }: { trackId: string | null }) => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    const room = roomStore.setNowPlaying(code, trackId);
    if (room) io.to(code).emit("room:state", room);
  });
}
