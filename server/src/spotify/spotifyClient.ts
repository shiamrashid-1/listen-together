let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) {
    return cachedToken.value;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Spotify credentials are not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in server/.env."
    );
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Spotify app token (${response.status})`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

export interface SpotifyTrackResult {
  uri: string;
  name: string;
  artists: string;
  albumArt: string | null;
  durationMs: number;
}

export async function searchTracks(query: string, limit = 10): Promise<SpotifyTrackResult[]> {
  const token = await getAppToken();
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Spotify search failed (${response.status})`);
  }

  const data = (await response.json()) as {
    tracks: {
      items: Array<{
        uri: string;
        name: string;
        artists: Array<{ name: string }>;
        album: { images: Array<{ url: string }> };
        duration_ms: number;
      }>;
    };
  };

  return data.tracks.items.map((item) => ({
    uri: item.uri,
    name: item.name,
    artists: item.artists.map((a) => a.name).join(", "),
    albumArt: item.album.images[0]?.url ?? null,
    durationMs: item.duration_ms,
  }));
}

// --- Authorization Code flow (per-host, used to control real playback) ---

const SPOTIFY_SCOPES = "user-modify-playback-state user-read-playback-state user-read-currently-playing";

function getCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Spotify credentials are not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in server/.env."
    );
  }
  return { clientId, clientSecret };
}

export function getAuthorizeUrl(state: string, redirectUri: string): string {
  const { clientId } = getCredentials();
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SPOTIFY_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface HostTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<HostTokenResult> {
  const { clientId, clientSecret } = getCredentials();
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Spotify token exchange failed (${response.status})`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

/**
 * Thrown by `refreshAccessToken` on failure. `definitive` distinguishes a
 * refresh token that Spotify has actually rejected (revoked/rotated out -
 * reconnecting is the only fix) from a transient hiccup (network blip, rate
 * limit, Spotify 5xx) that's worth simply retrying later without treating
 * the whole connection as dead. See `tokenStore.getValidAccessToken`.
 */
export class SpotifyRefreshError extends Error {
  constructor(message: string, public readonly definitive: boolean) {
    super(message);
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<HostTokenResult> {
  const { clientId, clientSecret } = getCredentials();

  let response: Response;
  try {
    response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    throw new SpotifyRefreshError(`Network error reaching Spotify's token endpoint: ${err}`, false);
  }

  if (!response.ok) {
    // Spotify returns 400 with error=invalid_grant specifically when the
    // refresh token itself has been revoked/rotated out from under us -
    // that's the only case where the host actually needs to reconnect.
    // Everything else (429 rate limit, 5xx, or a body we can't read) is
    // transient and shouldn't throw away a perfectly good connection.
    const definitive = response.status === 400 || response.status === 401;
    throw new SpotifyRefreshError(`Spotify token refresh failed (${response.status})`, definitive);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export type QueueTrackResult =
  | { ok: true }
  | { ok: false; error: "premium_required" | "no_active_device" | "unknown" };

export async function queueTrackForUser(accessToken: string, uri: string): Promise<QueueTrackResult> {
  const url = new URL("https://api.spotify.com/v1/me/player/queue");
  url.searchParams.set("uri", uri);

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204 || response.ok) return { ok: true };
  if (response.status === 403) return { ok: false, error: "premium_required" };
  if (response.status === 404) return { ok: false, error: "no_active_device" };
  return { ok: false, error: "unknown" };
}

// --- Reading real playback state (for the Now Playing / Up Next display) ---

export interface SpotifyPlaybackTrack {
  uri: string;
  name: string;
  artists: string;
  albumArt: string | null;
  durationMs: number;
}

export interface CurrentPlayback {
  track: SpotifyPlaybackTrack;
  progressMs: number;
  isPlaying: boolean;
}

interface RawSpotifyTrack {
  uri: string;
  name: string;
  artists: Array<{ name: string }>;
  album: { images: Array<{ url: string }> };
  duration_ms: number;
}

function mapRawTrack(item: RawSpotifyTrack): SpotifyPlaybackTrack {
  return {
    uri: item.uri,
    name: item.name,
    artists: item.artists.map((a) => a.name).join(", "),
    albumArt: item.album.images[0]?.url ?? null,
    durationMs: item.duration_ms,
  };
}

/**
 * Returns null when there's *legitimately* nothing playing (204, or a valid
 * response with no item loaded - e.g. paused with nothing queued up).
 * Throws for anything else (network error, rate limit, Spotify-side 5xx) so
 * callers can tell "nothing playing" apart from "couldn't find out right
 * now" and avoid clobbering a perfectly good now-playing display with a
 * false-empty one - see `playbackPoller.ts`.
 */
export async function getCurrentPlayback(accessToken: string): Promise<CurrentPlayback | null> {
  const response = await fetch("https://api.spotify.com/v1/me/player", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Spotify playback fetch failed (${response.status})`);

  const data = (await response.json()) as {
    item: RawSpotifyTrack | null;
    progress_ms: number | null;
    is_playing: boolean;
  };
  if (!data.item) return null;

  return {
    track: mapRawTrack(data.item),
    progressMs: data.progress_ms ?? 0,
    isPlaying: data.is_playing,
  };
}

/**
 * Spotify's own upcoming queue for the user's active session - separate
 * from our in-app wishlist. Throws on failure rather than returning an
 * empty list - see `getCurrentPlayback`'s note on why that distinction
 * matters here.
 */
export async function getUpcomingQueue(accessToken: string): Promise<SpotifyPlaybackTrack[]> {
  const response = await fetch("https://api.spotify.com/v1/me/player/queue", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Spotify queue fetch failed (${response.status})`);

  const data = (await response.json()) as { queue: RawSpotifyTrack[] };
  return (data.queue ?? []).slice(0, 15).map(mapRawTrack);
}

export type SkipResult = { ok: true } | { ok: false; error: "no_active_device" | "unknown" };

/** Skips to the next track on the host's actual Spotify playback session. */
export async function skipToNext(accessToken: string): Promise<SkipResult> {
  const response = await fetch("https://api.spotify.com/v1/me/player/next", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204 || response.ok) return { ok: true };
  if (response.status === 404) return { ok: false, error: "no_active_device" };
  return { ok: false, error: "unknown" };
}
