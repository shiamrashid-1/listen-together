import type { Server, Socket } from "socket.io";
import * as roomStore from "../rooms/roomStore.js";

type ChatSendAck = (res: { ok: true } | { ok: false; error: string }) => void;

export function registerChatHandlers(io: Server, socket: Socket) {
  socket.on("chat:send", ({ text }: { text: string }, ack?: ChatSendAck) => {
    const roomCode = socket.data.roomCode as string | undefined;
    if (!roomCode) {
      ack?.({ ok: false, error: "You're not in a room." });
      return;
    }

    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      ack?.({ ok: false, error: "Message is empty." });
      return;
    }

    const senderName = (socket.data.name as string | undefined) ?? "Guest";
    const message = roomStore.addChatMessage(roomCode, socket.id, senderName, trimmed);
    if (!message) {
      ack?.({ ok: false, error: "Room not found." });
      return;
    }

    io.to(roomCode).emit("chat:message", message);
    ack?.({ ok: true });
  });
}
