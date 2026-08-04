import { useEffect, useState } from "react";
import { socket } from "../lib/socket";
import { formatDuration } from "../lib/format";
import type { PlaybackInfo } from "../types";

/**
 * Ticks a live "elapsed ms" value forward from `progressMs`/`fetchedAt`,
 * without any network chatter in between broadcasts. Pauses ticking when the
 * source reports playback is paused. Resyncs instantly whenever a fresh
 * `PlaybackInfo` arrives.
 */
function useElapsedMs(playback: PlaybackInfo | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!playback) {
      setElapsed(0);
      return;
    }

    const tick = () => {
      const base = playback.progressMs + (playback.isPlaying ? Date.now() - playback.fetchedAt : 0);
      setElapsed(Math.min(Math.max(base, 0), playback.track.durationMs));
    };
    tick();

    if (!playback.isPlaying) return;
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [playback]);

  return elapsed;
}

interface NowPlayingCardProps {
  playback: PlaybackInfo | null;
  isHost: boolean;
  selfId: string | null;
  /** Participant IDs who've voted to skip the current track. */
  skipVoterIds: string[];
  /** How many votes are needed to skip, given the current room size. */
  skipVotesRequired: number;
  emptyMessage?: string;
}

export default function NowPlayingCard({
  playback,
  isHost,
  selfId,
  skipVoterIds,
  skipVotesRequired,
  emptyMessage,
}: NowPlayingCardProps) {
  const elapsed = useElapsedMs(playback);
  const skip = () => socket.emit("queue:skip");
  const voteSkip = () => socket.emit("queue:vote-skip");
  const hasVoted = Boolean(selfId && skipVoterIds.includes(selfId));

  if (!playback) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-white/50">Now playing</p>
        <p className="mt-3 text-sm text-white/50">
          {emptyMessage ?? "Nothing queued yet - add a song below to get started."}
        </p>
      </div>
    );
  }

  const { track } = playback;
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
          {track.addedBy ? <p className="mt-1 truncate text-xs text-white/40">added by {track.addedBy}</p> : null}
          {!playback.isPlaying ? <p className="mt-1 truncate text-xs text-amber-400/80">Paused on Spotify</p> : null}
        </div>
        {isHost ? (
          <button
            onClick={skip}
            title="Skip"
            className="flex-shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            Skip ▸
          </button>
        ) : (
          <button
            onClick={voteSkip}
            title={hasVoted ? "Remove your vote to skip" : "Vote to skip this track"}
            className={`flex-shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
              hasVoted
                ? "border-amber-400/50 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20"
                : "border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
            }`}
          >
            {hasVoted ? "Voted ✓" : "Vote skip"} ({skipVoterIds.length}/{skipVotesRequired})
          </button>
        )}
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
