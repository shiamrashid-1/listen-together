import { useEffect, useState } from "react";
import { socket } from "../lib/socket";
import { formatDuration } from "../lib/format";
import type { NowPlaying } from "../types";

/**
 * Ticks a live "elapsed ms" value forward based on `startedAt`, without any
 * network chatter - the server only tells us when a track started, and we
 * derive progress locally from the clock. Resyncs instantly whenever the
 * server sends a new `nowPlaying` (new track, or a skip/restart).
 */
function useElapsedMs(nowPlaying: NowPlaying | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!nowPlaying) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.min(Date.now() - nowPlaying.startedAt, nowPlaying.track.durationMs));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [nowPlaying]);

  return elapsed;
}

export default function NowPlayingCard({ nowPlaying }: { nowPlaying: NowPlaying | null }) {
  const elapsed = useElapsedMs(nowPlaying);
  const skip = () => socket.emit("queue:skip");

  if (!nowPlaying) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-white/50">Now playing</p>
        <p className="mt-3 text-sm text-white/50">Nothing queued yet - add a song below to get started.</p>
      </div>
    );
  }

  const { track } = nowPlaying;
  const progressPercent = track.durationMs > 0 ? Math.min(100, (elapsed / track.durationMs) * 100) : 0;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">Now playing</p>

      <div className="mt-3 flex items-center gap-4">
        {track.albumArt ? (
          <img src={track.albumArt} alt="" className="h-20 w-20 flex-shrink-0 rounded-lg object-cover shadow-lg" />
        ) : (
          <div className="h-20 w-20 flex-shrink-0 rounded-lg bg-white/10" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-white">{track.name}</p>
          <p className="truncate text-sm text-white/60">{track.artists}</p>
          <p className="mt-1 truncate text-xs text-white/40">added by {track.addedBy}</p>
        </div>
        <button
          onClick={skip}
          title="Skip"
          className="flex-shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          Skip ▸
        </button>
      </div>

      <div className="mt-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-200 ease-linear"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-white/40">
          <span>{formatDuration(elapsed)}</span>
          <span>{formatDuration(track.durationMs)}</span>
        </div>
      </div>
    </div>
  );
}
