import { refreshAccessToken, SpotifyRefreshError } from "./spotifyClient.js";

interface HostTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// Keyed by room code, not socket id — sockets churn on reconnect, but the
// host's Spotify authorization should survive brief network hiccups. It's
// cleared explicitly when the host changes or the room is deleted.
const tokensByRoom = new Map<string, HostTokens>();

// Both the playback poller (every 4s) and any queue:add can call
// getValidAccessToken around the same time. Without de-duping, two
// concurrent calls could both see a near-expired token and both fire a
// refresh - and if Spotify happens to rotate/invalidate the refresh token
// on use, the second (losing) request fails with invalid_grant, which used
// to wipe out a perfectly good connection. Tracking the in-flight refresh
// per room means every concurrent caller awaits the *same* attempt instead.
const refreshesInFlight = new Map<string, Promise<string | null>>();

export function set(code: string, accessToken: string, refreshToken: string, expiresInSeconds: number) {
  tokensByRoom.set(code.toUpperCase(), {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  });
}

export function clear(code: string) {
  tokensByRoom.delete(code.toUpperCase());
}

export function isConnected(code: string): boolean {
  return tokensByRoom.has(code.toUpperCase());
}

/**
 * Returns a currently-valid access token for the room's host, refreshing it
 * first if it's expired or about to expire. Returns null if the host never
 * connected Spotify, or if the refresh attempt fails.
 *
 * A failed refresh only drops the stored tokens (forcing a real reconnect)
 * when Spotify has definitively rejected the refresh token itself - see
 * `SpotifyRefreshError`. A transient failure (network blip, rate limit,
 * Spotify-side 5xx) leaves the existing tokens in place and just returns
 * null for this call, so the very next call (e.g. the poller 4s later)
 * naturally retries instead of the whole connection being wiped out from
 * under a still-valid session.
 */
export async function getValidAccessToken(code: string): Promise<string | null> {
  const upperCode = code.toUpperCase();
  const entry = tokensByRoom.get(upperCode);
  if (!entry) return null;

  if (entry.expiresAt > Date.now() + 5000) {
    return entry.accessToken;
  }

  const existingRefresh = refreshesInFlight.get(upperCode);
  if (existingRefresh) return existingRefresh;

  const refreshPromise = (async () => {
    try {
      const refreshed = await refreshAccessToken(entry.refreshToken);
      const nextEntry: HostTokens = {
        accessToken: refreshed.accessToken,
        // Spotify doesn't always return a new refresh token; keep the old one if so.
        refreshToken: refreshed.refreshToken ?? entry.refreshToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
      };
      tokensByRoom.set(upperCode, nextEntry);
      return nextEntry.accessToken;
    } catch (err) {
      const definitive = err instanceof SpotifyRefreshError ? err.definitive : false;
      if (definitive) tokensByRoom.delete(upperCode);
      return null;
    } finally {
      refreshesInFlight.delete(upperCode);
    }
  })();

  refreshesInFlight.set(upperCode, refreshPromise);
  return refreshPromise;
}
