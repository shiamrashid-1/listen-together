import { io, type Socket } from "socket.io-client";

export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

export const socket: Socket = io(SERVER_URL, {
  autoConnect: false,
});
