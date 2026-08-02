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
