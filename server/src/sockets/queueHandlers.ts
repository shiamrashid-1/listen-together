import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";
import * as tokenStore from "../spotify/tokenStore.js";
import { queueTrackForUser, skipToNext } from "../spotify/spotifyClient.js";
import type { QueueTrack } from "../types.js";

type QueueAddAck = (res: { ok: true; pushedToSpotify: boolean; spotifyError?: string } | { ok: false; error: string }) => void;

/**
 * Actually advances past whatever's playing - shared by the host's instant
 * Skip button and vote-skip once it crosses its threshold. Always advances
 * our own simulated queue model, and (best-effort) also tells Spotify's API
 * to skip if the host has connected their account, since that's the
 * playback actually reaching listeners' ears in that mode.
 */
export async function performSkip(code: string, io: Server) {
  const room = roomStore.skipCurrent(code);
  if (room) io.to(code).emit("room:state", room);

  const accessToken = await tokenStore.getValidAccessToken(code);
  if (accessToken) {
    await skipToNext(accessToken).catch(() => {});
  }
}

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
      // Log who added it so the playback poller can attribute it once it
      // shows up in Spotify's own queue (which has no "addedBy" of its own).
      roomStore.recordSpotifyAttribution(code, track.uri, name ?? "Someone");
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

  // Instant skip - host only. Everyone else has to use queue:vote-skip.
  socket.on("queue:skip", async () => {
    const code = socket.data.roomCode as string | undefined;
    if (!code || !roomStore.isHost(code, socket.id)) return;
    await performSkip(code, io);
  });

  // Toggles the caller's vote to skip whatever's currently playing. Once
  // votes cross the room's majority threshold, the skip actually happens.
  socket.on("queue:vote-skip", async () => {
    const code = socket.data.roomCode as string | undefined;
    if (!code) return;
    const result = roomStore.voteSkip(code, socket.id);
    if (!result) return;
    io.to(code).emit("room:state", result.state);
    if (result.shouldSkip) await performSkip(code, io);
  });
}
