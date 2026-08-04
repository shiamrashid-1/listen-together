import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { socket } from "../lib/socket";
import type { RoomState } from "../types";

interface RoomContextValue {
  room: RoomState | null;
  selfId: string | null;
  selfName: string;
  connectionError: string | null;
  isConnecting: boolean;
  createRoom: (name: string) => Promise<RoomState>;
  joinRoom: (code: string, name: string) => Promise<RoomState>;
  leaveRoom: () => void;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function RoomProvider({ children }: { children: ReactNode }) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [selfName, setSelfName] = useState("");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // Track the room/name we're supposed to be in, independent of React state
  // timing, so a reconnect handler can always see the latest values.
  const activeRoomRef = useRef<{ code: string; name: string } | null>(null);
  const hasConnectedBeforeRef = useRef(false);

  // A network hiccup (the same kind that can interrupt WebRTC on stricter
  // networks) can also drop the Socket.IO connection, which reconnects with
  // a brand-new socket id - as far as the server is concerned that looks
  // like a totally different participant. This id is generated once per tab
  // and sent along with every create/join so the server can recognize "this
  // is the same browser reconnecting" and hand identity (host status, etc.)
  // back over, instead of treating it as someone else joining while the old
  // slot quietly gets cleaned up as a departure.
  const clientIdRef = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    const handleRoomState = (nextRoom: RoomState) => setRoom(nextRoom);

    const handleConnect = () => {
      setSelfId(socket.id ?? null);

      // The server gives every new socket connection a blank slate - it has
      // no memory of which room this browser tab was in. If we reconnected
      // (rather than connecting for the first time) while believing we were
      // still in a room, silently rejoin so server-side state (needed for
      // adding to the queue, sharing audio, etc.) is restored.
      if (hasConnectedBeforeRef.current && activeRoomRef.current) {
        const { code, name } = activeRoomRef.current;
        socket.emit(
          "room:join",
          { code, name, clientId: clientIdRef.current },
          (res: { ok: true; room: RoomState } | { ok: false; error: string }) => {
            if (res.ok) {
              setRoom(res.room);
              setSelfId(socket.id ?? null);
            } else {
              setConnectionError("Lost connection to the room and couldn't rejoin. Try refreshing.");
            }
          }
        );
      }
      hasConnectedBeforeRef.current = true;
    };

    const handleConnectError = () => setConnectionError("Couldn't reach the server. Is it running?");

    socket.on("room:state", handleRoomState);
    socket.on("connect", handleConnect);
    socket.on("connect_error", handleConnectError);

    return () => {
      socket.off("room:state", handleRoomState);
      socket.off("connect", handleConnect);
      socket.off("connect_error", handleConnectError);
    };
  }, []);

  const ensureConnected = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      if (socket.connected) {
        resolve();
        return;
      }
      setIsConnecting(true);
      socket.connect();
      const onConnect = () => {
        setIsConnecting(false);
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
        resolve();
      };
      const onError = () => {
        setIsConnecting(false);
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
        reject(new Error("Couldn't reach the server. Is it running?"));
      };
      socket.on("connect", onConnect);
      socket.on("connect_error", onError);
    });
  }, []);

  const createRoom = useCallback(
    async (name: string) => {
      setConnectionError(null);
      await ensureConnected();
      setSelfName(name);
      return new Promise<RoomState>((resolve, reject) => {
        socket.emit(
          "room:create",
          { name, clientId: clientIdRef.current },
          (res: { ok: true; room: RoomState } | { ok: false; error: string }) => {
            if (res.ok) {
              activeRoomRef.current = { code: res.room.code, name };
              setRoom(res.room);
              setSelfId(socket.id ?? null);
              resolve(res.room);
            } else {
              reject(new Error(res.error));
            }
          }
        );
      });
    },
    [ensureConnected]
  );

  const joinRoom = useCallback(
    async (code: string, name: string) => {
      setConnectionError(null);
      await ensureConnected();
      setSelfName(name);
      return new Promise<RoomState>((resolve, reject) => {
        socket.emit(
          "room:join",
          { code, name, clientId: clientIdRef.current },
          (res: { ok: true; room: RoomState } | { ok: false; error: string }) => {
            if (res.ok) {
              activeRoomRef.current = { code: res.room.code, name };
              setRoom(res.room);
              setSelfId(socket.id ?? null);
              resolve(res.room);
            } else {
              reject(new Error(res.error));
            }
          }
        );
      });
    },
    [ensureConnected]
  );

  const leaveRoom = useCallback(() => {
    activeRoomRef.current = null;
    socket.disconnect();
    setRoom(null);
    setSelfId(null);
  }, []);

  const value = useMemo(
    () => ({ room, selfId, selfName, connectionError, isConnecting, createRoom, joinRoom, leaveRoom }),
    [room, selfId, selfName, connectionError, isConnecting, createRoom, joinRoom, leaveRoom]
  );

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoom() {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error("useRoom must be used within a RoomProvider");
  return ctx;
}
