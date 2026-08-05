import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { formatClockTime } from "../lib/format";
import type { ChatMessage } from "../types";

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
}

interface DocumentPictureInPictureApi {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

interface ChatBoxProps {
  messages: ChatMessage[];
  selfId: string | null;
  onSend: (text: string) => void;
}

const POPOUT_WIDTH = 340;
const POPOUT_HEIGHT = 480;

const isPipSupported = typeof window !== "undefined" && "documentPictureInPicture" in window;

/**
 * A freshly-opened Picture-in-Picture window is a blank document with none
 * of the host page's CSS - this copies every stylesheet over so the popped-
 * out chat looks the same as it does inline.
 */
function copyStylesInto(target: Window) {
  Array.from(document.styleSheets).forEach((sheet) => {
    try {
      if (sheet.href) {
        const link = target.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.document.head.appendChild(link);
      } else if (sheet.cssRules) {
        const style = target.document.createElement("style");
        style.textContent = Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join("\n");
        target.document.head.appendChild(style);
      }
    } catch {
      // Cross-origin stylesheets throw on cssRules access - nothing to copy.
    }
  });
  target.document.title = "Chat - Listen Together";
  target.document.documentElement.style.height = "100%";
  target.document.body.style.height = "100%";
  target.document.body.style.margin = "0";
  target.document.body.style.background = "#0b0d12";
}

interface ChatPanelProps extends ChatBoxProps {
  isPoppedOut: boolean;
  /** Only relevant when isPoppedOut is false - offers the "Pop out" control. */
  onPopOut?: () => void;
  /** Only relevant when isPoppedOut is true - lets the user dock it back inline. */
  onDock?: () => void;
}

/**
 * The actual chat UI, self-contained enough to be mounted twice
 * independently (once inline, once in a popped-out window) without sharing
 * any state beyond the props every mount already gets passed directly -
 * see the note in ChatBox below on why this can't just be portaled instead.
 */
function ChatPanel({ messages, selfId, onSend, isPoppedOut, onPopOut, onDock }: ChatPanelProps) {
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
      <div className="flex flex-shrink-0 items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-white/50">Chat</p>
        {isPoppedOut ? (
          <button
            type="button"
            onClick={onDock}
            title="Bring chat back into the page"
            className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            Dock
          </button>
        ) : isPipSupported ? (
          <button
            type="button"
            onClick={onPopOut}
            title="Pop out chat into a floating window that stays visible when you switch tabs"
            className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            Pop out ⧉
          </button>
        ) : null}
      </div>

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

export default function ChatBox({ messages, selfId, onSend }: ChatBoxProps) {
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const pipWindowRef = useRef<Window | null>(null);
  const pipRootRef = useRef<Root | null>(null);

  const closePopout = useCallback(() => {
    pipRootRef.current?.unmount();
    pipRootRef.current = null;
    pipWindowRef.current?.close();
    pipWindowRef.current = null;
    setIsPoppedOut(false);
  }, []);

  const openPopout = useCallback(async () => {
    if (!isPipSupported || pipWindowRef.current) return;
    try {
      const win = await window.documentPictureInPicture!.requestWindow({
        width: POPOUT_WIDTH,
        height: POPOUT_HEIGHT,
      });
      copyStylesInto(win);

      // A separate React root inside the PiP window's own document, rather
      // than createPortal-ing this tree's elements into it: React's event
      // delegation listens on the document the app was originally mounted
      // in, so clicks/typing on portaled elements living in a *different*
      // document (which is what a PiP window's document is) don't reliably
      // reach it. A second, fully independent root mounted directly in the
      // PiP window's document has its own working event handling, and is
      // kept in sync by just re-rendering it (see the effect below) whenever
      // this component's own props change.
      const container = win.document.createElement("div");
      container.style.height = "100%";
      win.document.body.appendChild(container);
      pipRootRef.current = createRoot(container);
      pipWindowRef.current = win;

      win.addEventListener("pagehide", () => {
        pipRootRef.current?.unmount();
        pipRootRef.current = null;
        pipWindowRef.current = null;
        setIsPoppedOut(false);
      });

      setIsPoppedOut(true);
    } catch (err) {
      // Most commonly: no fresh user gesture (e.g. the best-effort
      // auto-attempt on tab switch below). The manual button click is the
      // reliable path - silently ignore here.
      console.warn("[chat] couldn't open pop-out window:", err);
    }
  }, []);

  // Keep the popped-out window's independent React root showing the same
  // messages/selfId as they change, since it isn't a portal of this tree.
  useEffect(() => {
    if (!isPoppedOut || !pipRootRef.current) return;
    pipRootRef.current.render(
      <ChatPanel messages={messages} selfId={selfId} onSend={onSend} isPoppedOut onDock={closePopout} />
    );
  }, [isPoppedOut, messages, selfId, onSend, closePopout]);

  // Best-effort: if the tab goes into the background and chat isn't already
  // popped out, try to pop it out automatically. Browsers only allow
  // opening a Picture-in-Picture window within a short window after a
  // genuine user gesture (a click, a keypress) - switching tabs usually
  // doesn't carry one, so this quietly does nothing most of the time. The
  // "Pop out" button is what reliably works, since clicking it *is* that
  // gesture - this is just a bonus for the rare case it lines up.
  useEffect(() => {
    if (!isPipSupported) return;
    const handleVisibility = () => {
      if (document.hidden && !pipWindowRef.current) openPopout();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [openPopout]);

  useEffect(() => {
    return () => {
      pipRootRef.current?.unmount();
      pipWindowRef.current?.close();
    };
  }, []);

  if (isPoppedOut) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-5 text-center text-sm text-white/50">
        <p>Chat popped out into a floating window - it'll stay visible even if you switch tabs.</p>
        <button
          type="button"
          onClick={closePopout}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/10"
        >
          Bring it back
        </button>
      </div>
    );
  }

  return <ChatPanel messages={messages} selfId={selfId} onSend={onSend} isPoppedOut={false} onPopOut={openPopout} />;
}
