import type { Participant, QueueTrack, RoomState } from "../types.js";

interface Room {
  code: string;
  hostId: string;
  participants: Map<string, Participant>;
  queue: QueueTrack[];
  nowPlayingId: string | null;
  isSharing: boolean;
  spotifyConnected: boolean;
  createdAt: number;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L to avoid ambiguity
const CODE_LENGTH = 6;

const rooms = new Map<string, Room>();

function generateCode(): string {
  let code: string;
  do {
    code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function toRoomState(room: Room): RoomState {
  return {
    code: room.code,
    hostId: room.hostId,
    participants: Array.from(room.participants.values()),
    queue: room.queue,
    nowPlayingId: room.nowPlayingId,
    isSharing: room.isSharing,
    spotifyConnected: room.spotifyConnected,
  };
}

export function createRoom(hostId: string, hostName: string): RoomState {
  const code = generateCode();
  const room: Room = {
    code,
    hostId,
    participants: new Map([[hostId, { id: hostId, name: hostName, isHost: true }]]),
    queue: [],
    nowPlayingId: null,
    isSharing: false,
    spotifyConnected: false,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return toRoomState(room);
}

export function joinRoom(code: string, participantId: string, name: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  room.participants.set(participantId, { id: participantId, name, isHost: false });
  return toRoomState(room);
}

export function getRoom(code: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  return room ? toRoomState(room) : null;
}

export function findRoomByParticipant(participantId: string): Room | null {
  for (const room of rooms.values()) {
    if (room.participants.has(participantId)) return room;
  }
  return null;
}

/**
 * Removes a participant. If the host leaves, promotes the longest-standing
 * remaining participant to host. Deletes the room once empty.
 * Returns the updated room state, or null if the room no longer exists.
 */
export function removeParticipant(
  participantId: string
): { room: RoomState; deleted: boolean; hostChanged: boolean } | null {
  const room = findRoomByParticipant(participantId);
  if (!room) return null;

  room.participants.delete(participantId);

  if (room.participants.size === 0) {
    rooms.delete(room.code);
    return { room: toRoomState(room), deleted: true, hostChanged: false };
  }

  let hostChanged = false;
  if (room.hostId === participantId) {
    const [nextHostId, nextHost] = room.participants.entries().next().value as [string, Participant];
    room.hostId = nextHostId;
    room.participants.set(nextHostId, { ...nextHost, isHost: true });
    room.isSharing = false; // previous host's audio share is gone
    hostChanged = true;
  }

  return { room: toRoomState(room), deleted: false, hostChanged };
}

export function setSharing(code: string, isSharing: boolean): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  room.isSharing = isSharing;
  return toRoomState(room);
}

export function setSpotifyConnected(code: string, connected: boolean): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  room.spotifyConnected = connected;
  return toRoomState(room);
}

export function isHost(code: string, participantId: string): boolean {
  const room = rooms.get(code.toUpperCase());
  return room?.hostId === participantId;
}

export function addQueueTrack(code: string, track: Omit<QueueTrack, "id">): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  room.queue.push({ ...track, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  return toRoomState(room);
}

export function removeQueueTrack(code: string, trackId: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  room.queue = room.queue.filter((t) => t.id !== trackId);
  if (room.nowPlayingId === trackId) room.nowPlayingId = null;
  return toRoomState(room);
}

export function reorderQueue(code: string, orderedIds: string[]): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  const byId = new Map(room.queue.map((t) => [t.id, t]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter((t): t is QueueTrack => Boolean(t));
  // Preserve any tracks not included in orderedIds (defensive, shouldn't normally happen).
  const missing = room.queue.filter((t) => !orderedIds.includes(t.id));
  room.queue = [...reordered, ...missing];
  return toRoomState(room);
}

export function setNowPlaying(code: string, trackId: string | null): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  room.nowPlayingId = trackId;
  return toRoomState(room);
}
