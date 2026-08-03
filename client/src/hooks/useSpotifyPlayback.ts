import { useEffect, useState } from "react";
import { socket } from "../lib/socket";
import type { SpotifyPlaybackState } from "../types";

/**
 * Subscribes to the server's periodic broadcast of the host's real Spotify
 * playback state. Only meaningful while `enabled` (i.e. the room has a
 * connected Spotify host) - otherwise stays null.
 */
export function useSpotifyPlayback(enabled: boolean): SpotifyPlaybackState | null {
  const [state, setState] = useState<SpotifyPlaybackState | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }

    const handlePlayback = (payload: SpotifyPlaybackState) => setState(payload);
    socket.on("spotify:playback", handlePlayback);
    return () => {
      socket.off("spotify:playback", handlePlayback);
    };
  }, [enabled]);

  return state;
}
