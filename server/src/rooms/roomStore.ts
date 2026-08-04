import type { ChatMessage, NowPlaying, Participant, QueueTrack, RoomState } from "../types.js";

const MAX_CHAT_HISTORY = 100;
const MAX_MESSAGE_LENGTH = 500;

/** Internal-only participant record - `clientId` is never sent to clients (see `toRoomState`). */
interface ParticipantRecord extends Participant {
  clientId?: string;
}

interface Room {
  code: string;
  hostId: string;
  participants: Map<string, ParticipantRecord>;
  queue: QueueTrack[];
  nowPlaying: NowPlaying | null;
  /** Timer that auto-advances to the next track when the current one ends. Never serialized. */
  advanceTimer: NodeJS.Timeout | null;
  isSharing: boolean;
  spotifyConnected: boolean;
  messages: ChatMessage[];
  createdAt: number;
  /** Participant IDs who've voted to skip whatever's in `nowPlaying`. Cleared whenever it changes. */
  skipVotes: Set<string>;
  /**
   * FIFO-per-URI log of who queued what through our app, used to attribute
   * tracks in the host's *real* Spotify queue (which has no concept of "who
   * added this") - see `recordSpotifyAttribution`/`matchSpotifyAttribution`.
   * Capped so a long-lived room doesn't grow this unboundedly.
   */
  spotifyAttribution: Array<{ uri: string; name: string }>;
  /**
   * Maps each browser tab's persistent client id to its current participant
   * (socket) id, so a reconnect can reclaim its old spot - see `joinRoom`.
   */
  clientIds: Map<string, string>;
  /**
   * Participants whose socket just disconnected, pending actual removal -
   * see `scheduleParticipantRemoval`. Kept in `participants` (so they don't
   * look like they left, and the room isn't deleted/host isn't reassigned)
   * until the grace timer fires without a reconnect reclaiming the slot.
   */
  pendingRemovals: Map<string, NodeJS.Timeout>;
}

const MAX_SPOTIFY_ATTRIBUTION_ENTRIES = 200;

/**
 * How long a disconnected participant's slot is held open for a reconnect
 * to reclaim (see `joinRoom`'s clientId matching) before being treated as a
 * genuine departure. Generous on purpose: a restrictive/flaky network can
 * take several socket.io reconnection attempts (with backoff) plus the
 * server's own ping-timeout-based disconnect detection to recover - the
 * same class of network trouble that can interrupt WebRTC. Without this,
 * a host's brief network blip looks identical to them leaving, which
 * reassigns host and silently disconnects Spotify.
 */
const DISCONNECT_GRACE_MS = 20000;

/** Strict majority of the current room, minimum 1 - used as the vote-skip threshold. */
function computeSkipVotesRequired(participantCount: number): number {
  return Math.max(1, Math.floor(participantCount / 2) + 1);
}

function clearSkipVotes(room: Room) {
  room.skipVotes.clear();
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
  clearSkipVotes(room);
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
    participants: Array.from(room.participants.values()).map(({ id, name, isHost }) => ({ id, name, isHost })),
    queue: room.queue,
    nowPlaying: room.nowPlaying,
    isSharing: room.isSharing,
    spotifyConnected: room.spotifyConnected,
    messages: room.messages,
    skipVoterIds: Array.from(room.skipVotes),
    skipVotesRequired: computeSkipVotesRequired(room.participants.size),
  };
}

export function createRoom(hostId: string, hostName: string, clientId?: string): RoomState {
  const code = generateCode();
  const room: Room = {
    code,
    hostId,
    participants: new Map([[hostId, { id: hostId, name: hostName, isHost: true, clientId }]]),
    queue: [],
    nowPlaying: null,
    advanceTimer: null,
    isSharing: false,
    spotifyConnected: false,
    messages: [],
    createdAt: Date.now(),
    skipVotes: new Set(),
    spotifyAttribution: [],
    clientIds: clientId ? new Map([[clientId, hostId]]) : new Map(),
    pendingRemovals: new Map(),
  };
  rooms.set(code, room);
  return toRoomState(room);
}

export function joinRoom(code: string, participantId: string, name: string, clientId?: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;

  // If this browser tab already held a spot in this room (most likely
  // reconnecting after a network blip) and hasn't been fully removed yet,
  // reclaim it under the new socket id instead of registering as a brand
  // new guest - this preserves host status, votes, etc. across the drop.
  const oldParticipantId = clientId ? room.clientIds.get(clientId) : undefined;
  if (oldParticipantId && room.participants.has(oldParticipantId) && oldParticipantId !== participantId) {
    const pendingTimer = room.pendingRemovals.get(oldParticipantId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      room.pendingRemovals.delete(oldParticipantId);
    }

    const existing = room.participants.get(oldParticipantId)!;
    room.participants.delete(oldParticipantId);
    room.participants.set(participantId, { ...existing, id: participantId, name });
    if (clientId) room.clientIds.set(clientId, participantId);
    if (room.hostId === oldParticipantId) room.hostId = participantId;
    if (room.skipVotes.delete(oldParticipantId)) room.skipVotes.add(participantId);
    return toRoomState(room);
  }

  room.participants.set(participantId, { id: participantId, name, isHost: false, clientId });
  if (clientId) room.clientIds.set(clientId, participantId);
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

/** Actually removes a participant - see `scheduleParticipantRemoval` for the debounced, public entry point. */
function finalizeRemoval(
  participantId: string
): { room: RoomState; deleted: boolean; hostChanged: boolean } | null {
  const room = findRoomByParticipant(participantId);
  if (!room) return null;

  room.participants.delete(participantId);
  room.skipVotes.delete(participantId);
  room.pendingRemovals.delete(participantId);
  for (const [clientId, mappedId] of room.clientIds) {
    if (mappedId === participantId) room.clientIds.delete(clientId);
  }

  if (room.participants.size === 0) {
    if (room.advanceTimer) clearTimeout(room.advanceTimer);
    for (const timer of room.pendingRemovals.values()) clearTimeout(timer);
    rooms.delete(room.code);
    return { room: toRoomState(room), deleted: true, hostChanged: false };
  }

  let hostChanged = false;
  if (room.hostId === participantId) {
    const [nextHostId, nextHost] = room.participants.entries().next().value as [string, ParticipantRecord];
    room.hostId = nextHostId;
    room.participants.set(nextHostId, { ...nextHost, isHost: true });
    room.isSharing = false; // previous host's audio share is gone
    hostChanged = true;
  }

  return { room: toRoomState(room), deleted: false, hostChanged };
}

/**
 * Called when a participant's socket disconnects. Rather than removing them
 * (and potentially reassigning host / tearing down Spotify) immediately, we
 * hold their slot open for `DISCONNECT_GRACE_MS` in case it's just a network
 * blip and `joinRoom` reclaims it with a matching clientId. `onFinalize`
 * only fires if the grace period elapses without a reclaim - i.e. it's a
 * genuine departure.
 */
export function scheduleParticipantRemoval(
  participantId: string,
  onFinalize: (result: { room: RoomState; deleted: boolean; hostChanged: boolean }) => void
): void {
  const room = findRoomByParticipant(participantId);
  if (!room || room.pendingRemovals.has(participantId)) return;

  const timer = setTimeout(() => {
    const result = finalizeRemoval(participantId);
    if (result) onFinalize(result);
  }, DISCONNECT_GRACE_MS);
  room.pendingRemovals.set(participantId, timer);
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
    clearSkipVotes(room);
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
  clearSkipVotes(room);
  return toRoomState(room);
}

/** Skips whatever's currently playing and advances to the next upcoming track (or idle, if none). */
export function skipCurrent(code: string): RoomState | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;
  playNextInternal(room);
  return toRoomState(room);
}

/**
 * Toggles `participantId`'s vote to skip whatever's currently playing.
 * `shouldSkip` tells the caller whether this vote just crossed the required
 * threshold - the caller is responsible for actually performing the skip
 * (which may also need to hit the Spotify API), since that's async and
 * roomStore stays synchronous.
 */
export function voteSkip(code: string, participantId: string): { state: RoomState; shouldSkip: boolean } | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;

  if (room.skipVotes.has(participantId)) {
    room.skipVotes.delete(participantId);
  } else {
    room.skipVotes.add(participantId);
  }

  const shouldSkip =
    room.nowPlaying !== null && room.skipVotes.size >= computeSkipVotesRequired(room.participants.size);
  return { state: toRoomState(room), shouldSkip };
}

/**
 * Records that `name` queued `uri` through our app, so it can later be
 * matched up against the host's real Spotify queue (which has no built-in
 * concept of who added a track). See `matchSpotifyAttribution`.
 */
export function recordSpotifyAttribution(code: string, uri: string, name: string): void {
  const room = rooms.get(code.toUpperCase());
  if (!room) return;
  room.spotifyAttribution.push({ uri, name });
  if (room.spotifyAttribution.length > MAX_SPOTIFY_ATTRIBUTION_ENTRIES) {
    room.spotifyAttribution.splice(0, room.spotifyAttribution.length - MAX_SPOTIFY_ATTRIBUTION_ENTRIES);
  }
}

/** Returns a copy of the room's queue-attribution log (see `recordSpotifyAttribution`). */
export function getSpotifyAttribution(code: string): Array<{ uri: string; name: string }> {
  const room = rooms.get(code.toUpperCase());
  return room ? [...room.spotifyAttribution] : [];
}

/** Appends a chat message and trims history to the last MAX_CHAT_HISTORY entries. */
export function addChatMessage(
  code: string,
  senderId: string,
  senderName: string,
  text: string
): ChatMessage | null {
  const room = rooms.get(code.toUpperCase());
  if (!room) return null;

  const message: ChatMessage = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId,
    senderName,
    text: text.trim().slice(0, MAX_MESSAGE_LENGTH),
    sentAt: Date.now(),
  };

  room.messages.push(message);
  if (room.messages.length > MAX_CHAT_HISTORY) {
    room.messages = room.messages.slice(-MAX_CHAT_HISTORY);
  }

  return message;
}
