import { useState } from "react";

export default function RoomCode({ code }: { code: string }) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const copy = async (text: string, kind: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard API may be unavailable (e.g. insecure context) - fail silently.
    }
  };

  const inviteLink = `${window.location.origin}/room/${code}`;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">Room code</p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-3xl font-bold tracking-[0.3em] text-white">{code}</span>
        <button
          onClick={() => copy(code, "code")}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/80 transition hover:bg-white/10"
        >
          {copied === "code" ? "Copied!" : "Copy"}
        </button>
      </div>
      <button
        onClick={() => copy(inviteLink, "link")}
        className="mt-3 w-full rounded-lg bg-brand/90 py-2 text-sm font-semibold text-black transition hover:brightness-110"
      >
        {copied === "link" ? "Invite link copied!" : "Copy invite link"}
      </button>
    </div>
  );
}
