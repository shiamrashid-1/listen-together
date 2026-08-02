import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useRoom } from "../context/RoomContext";

export default function Home() {
  const { createRoom, joinRoom } = useRoom();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a display name first.");
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const room = mode === "create" ? await createRoom(name) : await joinRoom(code, name);
      navigate(`/room/${room.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur">
        <h1 className="text-3xl font-bold text-white">
          Listen <span className="text-brand">Together</span>
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Create a room, share the code, and listen to Spotify together with friends.
        </p>

        <div className="mt-6 flex rounded-lg bg-black/30 p-1 text-sm font-medium">
          <button
            type="button"
            className={`flex-1 rounded-md py-2 transition ${
              mode === "create" ? "bg-brand text-black" : "text-white/70 hover:text-white"
            }`}
            onClick={() => setMode("create")}
          >
            Create a room
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md py-2 transition ${
              mode === "join" ? "bg-brand text-black" : "text-white/70 hover:text-white"
            }`}
            onClick={() => setMode("join")}
          >
            Join a room
          </button>
        </div>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
              Your name
            </label>
            <input
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white placeholder-white/30 outline-none focus:border-brand"
              placeholder="e.g. Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
            />
          </div>

          {mode === "join" && (
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-white/50">
                Room code
              </label>
              <input
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 uppercase tracking-widest text-white placeholder-white/30 outline-none focus:border-brand"
                placeholder="ABC123"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={6}
              />
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-brand py-2.5 font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
          >
            {isSubmitting ? "Connecting…" : mode === "create" ? "Create room" : "Join room"}
          </button>
        </form>
      </div>
    </div>
  );
}
