import type { Participant } from "../types";

export default function ParticipantList({
  participants,
  selfId,
  isSharing,
}: {
  participants: Participant[];
  selfId: string | null;
  isSharing: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">
        In the room ({participants.length})
      </p>
      <ul className="mt-3 space-y-2">
        {participants.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2 text-sm"
          >
            <span className="flex items-center gap-2 text-white">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand/20 text-xs font-semibold text-brand">
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              {p.name}
              {p.id === selfId && <span className="text-white/40">(you)</span>}
            </span>
            <span className="flex items-center gap-2">
              {p.isHost && isSharing && (
                <span className="h-2 w-2 animate-pulse rounded-full bg-brand" title="Sharing audio" />
              )}
              {p.isHost && (
                <span className="rounded-full bg-brand/20 px-2 py-0.5 text-xs font-medium text-brand">
                  Host
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
