import { socket } from "../lib/socket";
import { formatDuration } from "../lib/format";
import type { QueueTrack } from "../types";

export default function Queue({ queue, nowPlayingId }: { queue: QueueTrack[]; nowPlayingId: string | null }) {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= queue.length) return;
    const ids = queue.map((t) => t.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    socket.emit("queue:reorder", { orderedIds: ids });
  };

  const remove = (trackId: string) => socket.emit("queue:remove", { trackId });

  const toggleNowPlaying = (trackId: string) => {
    socket.emit("queue:mark-playing", { trackId: nowPlayingId === trackId ? null : trackId });
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">
        Queue ({queue.length})
      </p>

      {queue.length === 0 ? (
        <p className="mt-3 text-sm text-white/50">
          No songs queued yet. Search above and add a few for the room.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {queue.map((track, index) => {
            const isNowPlaying = track.id === nowPlayingId;
            return (
              <li
                key={track.id}
                className={`flex items-center gap-3 rounded-lg px-2 py-2 ${
                  isNowPlaying ? "bg-brand/10 ring-1 ring-brand/40" : "hover:bg-white/5"
                }`}
              >
                {track.albumArt ? (
                  <img src={track.albumArt} alt="" className="h-10 w-10 rounded object-cover" />
                ) : (
                  <div className="h-10 w-10 rounded bg-white/10" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{track.name}</p>
                  <p className="truncate text-xs text-white/50">
                    {track.artists} · {formatDuration(track.durationMs)} · added by {track.addedBy}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-20"
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => move(index, 1)}
                    disabled={index === queue.length - 1}
                    className="rounded p-1 text-white/50 transition hover:bg-white/10 hover:text-white disabled:opacity-20"
                    title="Move down"
                  >
                    ▼
                  </button>
                  <button
                    onClick={() => toggleNowPlaying(track.id)}
                    className={`rounded px-2 py-1 text-xs font-medium transition ${
                      isNowPlaying ? "bg-brand text-black" : "text-white/60 hover:bg-white/10"
                    }`}
                    title="Mark as now playing"
                  >
                    {isNowPlaying ? "Playing" : "Play"}
                  </button>
                  <button
                    onClick={() => remove(track.id)}
                    className="rounded p-1 text-white/40 transition hover:bg-red-500/10 hover:text-red-400"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
