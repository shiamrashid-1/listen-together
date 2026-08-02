export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const FALLBACK_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // Metered rotates credentials periodically; refetch every 6h.

let cached: { value: IceServer[]; expiresAt: number } | null = null;

/**
 * Fetches a fresh set of ICE servers (STUN + TURN) from Metered's TURN
 * Credentials API (this also powers the free Open Relay Project). Falls back
 * to public STUN-only if no API key is configured or the request fails -
 * WebRTC will still work for most home networks, just without a TURN relay
 * fallback for stricter NATs/firewalls.
 */
export async function getIceServers(): Promise<IceServer[]> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const apiKey = process.env.METERED_API_KEY;
  const domain = process.env.METERED_DOMAIN;

  if (!apiKey || !domain) {
    return FALLBACK_ICE_SERVERS;
  }

  try {
    const response = await fetch(
      `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`
    );
    if (!response.ok) {
      throw new Error(`Metered TURN credentials request failed (${response.status})`);
    }
    const iceServers = (await response.json()) as IceServer[];
    cached = { value: iceServers, expiresAt: Date.now() + CACHE_TTL_MS };
    return iceServers;
  } catch (err) {
    console.error("[turn] falling back to STUN-only:", err);
    return FALLBACK_ICE_SERVERS;
  }
}
