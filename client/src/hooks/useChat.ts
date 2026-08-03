import { useCallback, useEffect, useRef, useState } from "react";
import { socket } from "../lib/socket";
import type { ChatMessage } from "../types";

/**
 * Live chat for the room. `roomMessages` (the history snapshot embedded in
 * `RoomState`) seeds/backfills on join or reconnect; new messages stream in
 * via the dedicated `chat:message` event so sending doesn't require a full
 * room-state broadcast. Merges are deduped by message id since the two
 * sources can overlap.
 */
export function useChat(roomMessages: ChatMessage[]) {
  const [messages, setMessages] = useState<ChatMessage[]>(roomMessages);
  const seenIds = useRef(new Set(roomMessages.map((m) => m.id)));

  useEffect(() => {
    const unseen = roomMessages.filter((m) => !seenIds.current.has(m.id));
    if (unseen.length === 0) return;
    unseen.forEach((m) => seenIds.current.add(m.id));
    setMessages((prev) => [...prev, ...unseen].sort((a, b) => a.sentAt - b.sentAt));
  }, [roomMessages]);

  useEffect(() => {
    const handleMessage = (message: ChatMessage) => {
      if (seenIds.current.has(message.id)) return;
      seenIds.current.add(message.id);
      setMessages((prev) => [...prev, message]);
    };
    socket.on("chat:message", handleMessage);
    return () => {
      socket.off("chat:message", handleMessage);
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    socket.emit("chat:send", { text: trimmed });
  }, []);

  return { messages, sendMessage };
}
