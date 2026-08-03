import { refreshAccessToken } from "./spotifyClient.js";

interface HostTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// Keyed by room code, not socket id — sockets churn on reconnect, but the
// host's Spotify authorization should survive brief network hiccups. It's
// cleared explicitly when the host changes or the room is deleted.
const tokensByRoom = new Map<string, HostTokens>();

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
 * connected Spotify, or if the refresh attempt fails (in which case the
 * stored tokens are dropped so the UI can prompt to reconnect).
 */
export async function getValidAccessToken(code: string): Promise<string | null> {
  const entry = tokensByRoom.get(code.toUpperCase());
  if (!entry) return null;

  if (entry.expiresAt > Date.now() + 5000) {
    return entry.accessToken;
  }

  try {
    const refreshed = await refreshAccessToken(entry.refreshToken);
    const nextEntry: HostTokens = {
      accessToken: refreshed.accessToken,
      // Spotify doesn't always return a new refresh token; keep the old one if so.
      refreshToken: refreshed.refreshToken ?? entry.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
    };
    tokensByRoom.set(code.toUpperCase(), nextEntry);
    return nextEntry.accessToken;
  } catch {
    tokensByRoom.delete(code.toUpperCase());
    return null;
  }
}
