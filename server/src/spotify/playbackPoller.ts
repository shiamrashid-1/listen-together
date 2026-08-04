import type { Server } from "socket.io";
import * as tokenStore from "./tokenStore.js";
import * as roomStore from "../rooms/roomStore.js";
import { getCurrentPlayback, getUpcomingQueue, type SpotifyPlaybackTrack } from "./spotifyClient.js";

const POLL_INTERVAL_MS = 4000;

type AttributedTrack = SpotifyPlaybackTrack & { addedBy?: string };

export interface SpotifyPlaybackBroadcast {
  nowPlaying: { track: AttributedTrack; progressMs: number; isPlaying: boolean; fetchedAt: number } | null;
  queue: AttributedTrack[];
}

const timers = new Map<string, NodeJS.Timeout>();

/**
 * Spotify's queue API has no concept of "who added this track" - it's just
 * whatever the account's session happens to have queued. We separately log
 * every track *we* pushed there (see `roomStore.recordSpotifyAttribution`)
 * and match it back up here, in order, per URI: the Nth occurrence of a URI
 * in the live sequence (now playing, then upcoming, in that order) gets the
 * Nth attribution logged for that same URI. Tracks queued directly in
 * Spotify (outside our app) simply have no match and get no attribution.
 */
function matchSpotifyAttribution(
  liveTracks: SpotifyPlaybackTrack[],
  attribution: Array<{ uri: string; name: string }>
): (string | undefined)[] {
  const nextIndexByUri = new Map<string, number>();
  return liveTracks.map((track) => {
    const startFrom = nextIndexByUri.get(track.uri) ?? 0;
    const matchIndex = attribution.findIndex((entry, i) => i >= startFrom && entry.uri === track.uri);
    if (matchIndex === -1) return undefined;
    nextIndexByUri.set(track.uri, matchIndex + 1);
    return attribution[matchIndex].name;
  });
}

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
      if (tokenStore.isConnected(upperCode)) {
        // Tokens still exist - this was a transient refresh hiccup (network
        // blip, rate limit, Spotify-side 5xx), not a real disconnection.
        // Skip this tick and retry shortly instead of wiping out a
        // perfectly good now-playing/queue display.
        return;
      }
      // The connection is genuinely dead (host revoked access, or the
      // refresh token was actually rejected) - stop polling and flip the
      // room back to "not connected" so the UI falls back to the in-app
      // simulated queue instead of being stuck showing a blank display.
      stopPolling(upperCode);
      const updated = roomStore.setSpotifyConnected(upperCode, false);
      if (updated) io.to(upperCode).emit("room:state", updated);
      io.to(upperCode).emit("spotify:playback", { nowPlaying: null, queue: [] } satisfies SpotifyPlaybackBroadcast);
      return;
    }

    let playback: Awaited<ReturnType<typeof getCurrentPlayback>>;
    let queue: SpotifyPlaybackTrack[];
    try {
      [playback, queue] = await Promise.all([getCurrentPlayback(accessToken), getUpcomingQueue(accessToken)]);
    } catch (err) {
      // Couldn't reach Spotify at all this round (rate limit, transient
      // 5xx, network blip) - don't broadcast a false-empty state over
      // what's likely still a perfectly good display. Just retry next tick.
      console.warn(`[spotify-poll:${upperCode}] fetch failed this tick, skipping broadcast:`, err);
      return;
    }

    if (!playback) console.log(`[spotify-poll:${upperCode}] Spotify reports nothing currently playing for this account`);

    const liveTracks = playback ? [playback.track, ...queue] : queue;
    const attribution = roomStore.getSpotifyAttribution(upperCode);
    const addedByList = matchSpotifyAttribution(liveTracks, attribution);
    const queueOffset = playback ? 1 : 0;

    const payload: SpotifyPlaybackBroadcast = {
      nowPlaying: playback
        ? { ...playback, track: { ...playback.track, addedBy: addedByList[0] }, fetchedAt: Date.now() }
        : null,
      queue: queue.map((track, i) => ({ ...track, addedBy: addedByList[queueOffset + i] })),
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
