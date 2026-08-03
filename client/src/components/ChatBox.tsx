import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatClockTime } from "../lib/format";
import type { ChatMessage } from "../types";

interface ChatBoxProps {
  messages: ChatMessage[];
  selfId: string | null;
  onSend: (text: string) => void;
}

export default function ChatBox({ messages, selfId, onSend }: ChatBoxProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="flex-shrink-0 text-xs font-medium uppercase tracking-wide text-white/50">Chat</p>

      <div ref={scrollRef} className="mt-3 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <p className="text-sm text-white/40">No messages yet. Say hi!</p>
        ) : (
          messages.map((message) => {
            const isSelf = message.senderId === selfId;
            return (
              <div key={message.id} className={`flex flex-col ${isSelf ? "items-end" : "items-start"}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${
                    isSelf ? "bg-brand text-black" : "bg-black/30 text-white"
                  }`}
                >
                  {!isSelf && <p className="text-xs font-semibold text-brand/90">{message.senderName}</p>}
                  <p className="whitespace-pre-wrap break-words">{message.text}</p>
                </div>
                <span className="mt-0.5 text-[10px] text-white/30">{formatClockTime(message.sentAt)}</span>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={handleSubmit} className="mt-3 flex flex-shrink-0 gap-2">
        <input
          className="w-full min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-brand"
          placeholder="Message the room…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="flex-shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
