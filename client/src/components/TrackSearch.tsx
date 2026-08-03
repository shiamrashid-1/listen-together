import { useEffect, useState } from "react";
import { SERVER_URL, socket } from "../lib/socket";
import { formatDuration } from "../lib/format";
import type { SpotifyTrackResult } from "../types";

const SPOTIFY_ERROR_MESSAGES: Record<string, string> = {
  premium_required: "Added to queue, but auto-queueing on Spotify needs Premium.",
  no_active_device: "Added to queue, but open Spotify and start playing something first.",
  unknown: "Added to queue, but Spotify auto-queue failed.",
};

export default function TrackSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpotifyTrackResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusByUri, setStatusByUri] = useState<Record<string, string>>({});

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      return;
    }

    const timeout = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`${SERVER_URL}/api/spotify/search?q=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Search failed.");
        setResults(data.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed.");
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 350);

    return () => clearTimeout(timeout);
  }, [query]);

  const showStatus = (uri: string, message: string) => {
    setStatusByUri((prev) => ({ ...prev, [uri]: message }));
    setTimeout(() => {
      setStatusByUri((prev) => {
        const next = { ...prev };
        delete next[uri];
        return next;
      });
    }, 4000);
  };

  const addToQueue = (track: SpotifyTrackResult) => {
    socket.emit(
      "queue:add",
      track,
      (res: { ok: true; pushedToSpotify: boolean; spotifyError?: string } | { ok: false; error: string }) => {
        if (!res.ok) {
          showStatus(track.uri, res.error);
        } else if (res.pushedToSpotify) {
          showStatus(track.uri, "Added and queued live on Spotify.");
        } else if (res.spotifyError) {
          showStatus(track.uri, SPOTIFY_ERROR_MESSAGES[res.spotifyError] ?? SPOTIFY_ERROR_MESSAGES.unknown);
        } else {
          showStatus(track.uri, "Added to queue.");
        }
      }
    );
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">Add a song</p>
      <input
        className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white placeholder-white/30 outline-none focus:border-brand"
        placeholder="Search Spotify…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {isLoading && <p className="mt-3 text-sm text-white/50">Searching…</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      {results.length > 0 && (
        <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
          {results.map((track) => (
            <li
              key={track.uri}
              className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-white/5"
            >
              {track.albumArt ? (
                <img src={track.albumArt} alt="" className="h-10 w-10 rounded object-cover" />
              ) : (
                <div className="h-10 w-10 rounded bg-white/10" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{track.name}</p>
                {statusByUri[track.uri] ? (
                  <p className="truncate text-xs text-brand">{statusByUri[track.uri]}</p>
                ) : (
                  <p className="truncate text-xs text-white/50">
                    {track.artists} · {formatDuration(track.durationMs)}
                  </p>
                )}
              </div>
              <button
                onClick={() => addToQueue(track)}
                className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/80 transition hover:bg-brand hover:text-black"
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
