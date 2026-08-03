import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";
import * as tokenStore from "../spotify/tokenStore.js";
import { queueTrackForUser } from "../spotify/spotifyClient.js";
import type { QueueTrack } from "../types.js";

type QueueAddAck = (res: { ok: true; pushedToSpotify: boolean; spotifyError?: string } | { ok: false; error: string }) => void;

export function registerQueueHandlers(io: Server, socket: Socket) {
  socket.on("queue:add", async (track: Omit<QueueTrack, "id" | "addedBy">, ack?: QueueAddAck) => {
    const code = socket.data.roomCode as string | undefined;
    const name = socket.data.name as string | undefined;
    if (!code) {
      ack?.({ ok: false, error: "You're not in a room." });
      return;
    }

    const room = roomStore.addQueueTrack(code, { ...track, addedBy: name ?? "Someone" });
    if (!room) {
      ack?.({ ok: false, error: "That room no longer exists." });
      return;
    }
    io.to(code).emit("room:state", room);

    // Also try to push straight onto the host's real Spotify queue, if connected.
    const accessToken = await tokenStore.getValidAccessToken(code);
    if (!accessToken) {
      ack?.({ ok: true, pushedToSpotify: false });
      return;
    }

    const result = await queueTrackForUser(accessToken, track.uri);
    if (result.ok) {
      ack?.({ ok: true, pushedToSpotify: true });
    } else {
      ack?.({ ok: true, pushedToSpotify: false, spotifyError: result.error });
    }
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

  socket.on("queue:play-now", ({ trackId }: { trackId: string }) => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    const room = roomStore.playNow(code, trackId);
    if (room) io.to(code).emit("room:state", room);
  });

  socket.on("queue:skip", () => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    const room = roomStore.skipCurrent(code);
    if (room) io.to(code).emit("room:state", room);
  });
}
