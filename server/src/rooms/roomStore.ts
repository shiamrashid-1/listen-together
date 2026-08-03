import type { NowPlaying, Participant, QueueTrack, RoomState } from "../types.js";

interface Room {
  code: string;
  hostId: string;
  participants: Map<string, Participant>;
  queue: QueueTrack[];
  nowPlaying: NowPlaying | null;
  /** Timer that auto-advances to the next track when the current one ends. Never serialized. */
  advanceTimer: NodeJS.Timeout | null;
  isSharing: boolean;
  spotifyConnected: boolean;
  createdAt: number;
}

type AdvanceListener = (state: RoomState) => void;
let advanceListener: AdvanceListener | null = null;

/** Registered once at server startup so the store can broadcast auto-advances without owning `io` itself. */
export function onQueueAdvance(listener: AdvanceListener) {
  advanceListener = listener;
}

/**
 * (Re)schedules the timer that moves the queue forward once the currently
 * playing track's duration has elapsed. Safe to call any time `nowPlaying`
 * changes - clears any existing timer first.
 */
function scheduleAdvance(room: Room) {
  if (room.advanceTimer) {
    clearTimeout(room.advanceTimer);
    room.advanceTimer = null;
  }
  if (!room.nowPlaying) return;

  const elapsed = Date.now() - room.nowPlaying.startedAt;
  const remaining = Math.max(0, room.nowPlaying.track.durationMs - elapsed);
  room.advanceTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return; // room was deleted while the timer was pending
    playNextInternal(room);
    advanceListener?.(toRoomState(room));
  }, remaining);
}

/** Shifts the next upcoming track (if any) into `nowPlaying` and reschedules. */
function playNextInternal(room: Room) {
  const next = room.queue.shift();
  room.nowPlaying = next ? { track: next, startedAt: Date.now() } : null;
  scheduleAdvance(room);
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
    nowPlaying: room.nowPlaying,
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
    nowPlaying: null,
    advanceTimer: null,
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
    if (room.advanceTimer) clearTimeout(room.advanceTimer);
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

/**
 * Adds a track to the upcoming queue. If nothing is currently playing (the
 * room was idle), the new track starts playing immediately instead of
 * sitting in an empty queue.
 */
export function addQueueTrack(code: string, track: Omit<QueueTrack, "id">): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  const newTrack: QueueTrack = { ...track, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };

  if (!room.nowPlaying) {
    room.nowPlaying = { track: newTrack, startedAt: Date.now() };
    scheduleAdvance(room);
  } else {
    room.queue.push(newTrack);
  }

  return toRoomState(room);
}

/**
 * Removes a track. Removing the currently playing track skips to whatever's
 * next, same as if it had finished naturally.
 */
export function removeQueueTrack(code: string, trackId: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;

  if (room.nowPlaying?.track.id === trackId) {
    playNextInternal(room);
  } else {
    room.queue = room.queue.filter((t) => t.id !== trackId);
  }

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

/**
 * Jumps straight to a specific track, wherever it currently sits (upcoming
 * queue, or already playing - which just restarts its progress). Everything
 * else keeps its relative order.
 */
export function playNow(code: string, trackId: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;

  let track: QueueTrack | undefined;
  const idx = room.queue.findIndex((t) => t.id === trackId);
  if (idx !== -1) {
    track = room.queue.splice(idx, 1)[0];
  } else if (room.nowPlaying?.track.id === trackId) {
    track = room.nowPlaying.track;
  }
  if (!track) return toRoomState(room);

  room.nowPlaying = { track, startedAt: Date.now() };
  scheduleAdvance(room);
  return toRoomState(room);
}

/** Skips whatever's currently playing and advances to the next upcoming track (or idle, if none). */
export function skipCurrent(code: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  playNextInternal(room);
  return toRoomState(room);
}
