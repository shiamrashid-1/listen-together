import type { Server } from "socket.io";
import * as tokenStore from "./tokenStore.js";
import { getCurrentPlayback, getUpcomingQueue, type SpotifyPlaybackTrack } from "./spotifyClient.js";

const POLL_INTERVAL_MS = 4000;

export interface SpotifyPlaybackBroadcast {
  nowPlaying: { track: SpotifyPlaybackTrack; progressMs: number; isPlaying: boolean; fetchedAt: number } | null;
  queue: SpotifyPlaybackTrack[];
}

const timers = new Map<string, NodeJS.Timeout>();

/**
 * Polls the host's real Spotify playback state (what's actually playing,
 * and what's actually queued up next on their account) and broadcasts it to
 * the room. Runs on a simple interval rather than any push mechanism -
 * Spotify's Web API has no webhook/subscription option for this.
 */
export function startPolling(code: string, io: Server) {
  const upperCode = code.toUpperCase();
  stopPolling(upperCode);

  const tick = async () => {
    const accessToken = await tokenStore.getValidAccessToken(upperCode);
    if (!accessToken) {
      stopPolling(upperCode);
      io.to(upperCode).emit("spotify:playback", { nowPlaying: null, queue: [] } satisfies SpotifyPlaybackBroadcast);
      return;
    }

    const [playback, queue] = await Promise.all([
      getCurrentPlayback(accessToken).catch(() => null),
      getUpcomingQueue(accessToken).catch(() => [] as SpotifyPlaybackTrack[]),
    ]);

    const payload: SpotifyPlaybackBroadcast = {
      nowPlaying: playback ? { ...playback, fetchedAt: Date.now() } : null,
      queue,
    };
    io.to(upperCode).emit("spotify:playback", payload);
  };

  tick();
  timers.set(upperCode, setInterval(tick, POLL_INTERVAL_MS));
}

export function stopPolling(code: string) {
  const upperCode = code.toUpperCase();
  const timer = timers.get(upperCode);
  if (timer) {
    clearInterval(timer);
    timers.delete(upperCode);
  }
}
