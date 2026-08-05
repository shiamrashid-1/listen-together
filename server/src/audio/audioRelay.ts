import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import ffmpegPath from "ffmpeg-static";

const PENDING_SUBSCRIBER_TIMEOUT_MS = 15000;
// How often buffered fragment output gets flushed to socket-based
// subscribers, as one combined chunk. This no longer needs to be large for
// decode-stability reasons (see extractInitSegment/MediaSource below) - it's
// just batching to keep the number of Socket.IO messages reasonable.
const SOCKET_CHUNK_FLUSH_MS = 300;

type ChunkListener = (chunk: Buffer) => void;

interface RoomRelay {
  ffmpeg: ChildProcessWithoutNullStreams;
  subscribers: Set<ServerResponse>;
  chunkListeners: Set<ChunkListener>;
  socketBuffer: Buffer[];
  socketFlushTimer: NodeJS.Timeout;
  /**
   * The cached ftyp+moov header every subscriber needs before any fragment
   * makes sense to a MediaSource SourceBuffer - see extractInitSegment.
   * null until the first bytes of ffmpeg's output have been classified.
   */
  initSegment: Buffer | null;
  /** Accumulates early output until extractInitSegment finds the boundary. */
  pendingInitBytes: Buffer;
}

const relays = new Map<string, RoomRelay>();
// Listeners that asked to subscribe before the host's first audio chunk
// arrived (and therefore before ffmpeg exists yet) - attached once it starts.
const pendingSubscribers = new Map<string, Set<ServerResponse>>();
const pendingChunkListeners = new Map<string, Set<ChunkListener>>();

function attachPendingSubscribers(code: string, relay: RoomRelay) {
  const pending = pendingSubscribers.get(code);
  if (pending) {
    pending.forEach((res) => relay.subscribers.add(res));
    pendingSubscribers.delete(code);
  }

  const pendingChunks = pendingChunkListeners.get(code);
  if (pendingChunks) {
    pendingChunks.forEach((listener) => relay.chunkListeners.add(listener));
    pendingChunkListeners.delete(code);
  }
}

/**
 * A fragmented-MP4 stream starts with an initialization segment (ftyp+moov
 * boxes describing the codec/track, empty of actual samples) followed by a
 * continuous run of moof+mdat fragments carrying the encoded audio. A
 * MediaSource SourceBuffer needs that init segment exactly once before it
 * can make sense of *any* fragment - so a listener who subscribes after the
 * relay has already been running for a while (and therefore missed the very
 * first bytes ffmpeg ever wrote) needs it replayed to them specifically, not
 * just whatever fragment happens to be flowing by when they join.
 *
 * This scans a growing byte buffer for the start of the first "moof" box,
 * splitting everything before it off as that cacheable init segment. Returns
 * null if the boundary hasn't shown up yet (caller should accumulate more
 * data and try again).
 */
function extractInitSegment(buffered: Buffer): { initSegment: Buffer; rest: Buffer } | null {
  let offset = 0;
  while (offset + 8 <= buffered.length) {
    const size = buffered.readUInt32BE(offset);
    const type = buffered.toString("ascii", offset + 4, offset + 8);
    if (size < 8) return null; // malformed or 64-bit extended-size box - bail and wait for more data
    if (type === "moof") {
      return { initSegment: buffered.subarray(0, offset), rest: buffered.subarray(offset) };
    }
    if (offset + size > buffered.length) return null; // this box isn't fully buffered yet
    offset += size;
  }
  return null;
}

/**
 * Spawns a per-room ffmpeg process that transcodes the host's live webm/opus
 * chunks (fed via stdin) into a continuous fragmented-MP4/AAC stream
 * (stdout), fanned out two ways: as a plain HTTP byte stream, and as
 * periodic binary chunks pushed over each listener's existing Socket.IO
 * connection (for networks that block long-lived streaming HTTP connections
 * outright but already allow that WebSocket traffic through, since the rest
 * of the app depends on it too).
 *
 * Fragmented MP4 (rather than a plain MP3 stream chopped into arbitrary
 * byte-range pieces) is specifically so listener playback can go through
 * MediaSource Extensions instead of decoding each delivered chunk
 * independently: independently decoding arbitrary MP3 byte ranges drops or
 * mis-syncs the partial frame at each chunk boundary, which is exactly what
 * caused the periodic "cutting"/glitchy-overlap artifacts - MSE keeps one
 * continuous decode timeline across every appended fragment, so there's no
 * per-chunk boundary to glitch at all.
 */
function startRelay(code: string): RoomRelay {
  const ffmpeg = spawn(ffmpegPath as unknown as string, [
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vn",
    "-acodec",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "500000",
    "pipe:1",
  ]);

  const relay: RoomRelay = {
    ffmpeg,
    subscribers: new Set(),
    chunkListeners: new Set(),
    socketBuffer: [],
    socketFlushTimer: setInterval(() => flushSocketBuffer(code, relay), SOCKET_CHUNK_FLUSH_MS),
    initSegment: null,
    pendingInitBytes: Buffer.alloc(0),
  };
  relays.set(code, relay);
  attachPendingSubscribers(code, relay);
  console.log(`[audio-relay:${code}] started (ffmpeg pid ${ffmpeg.pid})`);

  let loggedFirstOutput = false;
  ffmpeg.stdout.on("data", (chunk: Buffer) => {
    if (!loggedFirstOutput) {
      loggedFirstOutput = true;
      console.log(`[audio-relay:${code}] ffmpeg producing output (${relay.subscribers.size} HTTP subscriber(s))`);
    }

    let fragmentBytes = chunk;
    if (!relay.initSegment) {
      relay.pendingInitBytes = Buffer.concat([relay.pendingInitBytes, chunk]);
      const split = extractInitSegment(relay.pendingInitBytes);
      if (!split) return; // still accumulating the init segment - nothing to forward yet
      relay.initSegment = split.initSegment;
      relay.pendingInitBytes = Buffer.alloc(0);
      fragmentBytes = split.rest;
      console.log(`[audio-relay:${code}] captured ${relay.initSegment.length}-byte init segment`);
    }

    relay.subscribers.forEach((res) => {
      if (!res.writableEnded) res.write(fragmentBytes);
    });
    relay.socketBuffer.push(fragmentBytes);
  });

  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    console.error(`[audio-relay:${code}] ffmpeg: ${chunk.toString().trim()}`);
  });

  ffmpeg.on("error", (err) => {
    console.error(`[audio-relay:${code}] ffmpeg failed to start:`, err);
  });

  ffmpeg.on("exit", (exitCode) => {
    console.log(`[audio-relay:${code}] ffmpeg exited (${exitCode})`);
    clearInterval(relay.socketFlushTimer);
    relay.subscribers.forEach((res) => {
      if (!res.writableEnded) res.end();
    });
    relay.subscribers.clear();
    relay.chunkListeners.clear();
    if (relays.get(code) === relay) relays.delete(code);
  });

  return relay;
}

function flushSocketBuffer(code: string, relay: RoomRelay) {
  if (relay.socketBuffer.length === 0 || relay.chunkListeners.size === 0) {
    relay.socketBuffer.length = 0;
    return;
  }
  const combined = Buffer.concat(relay.socketBuffer);
  relay.socketBuffer.length = 0;
  relay.chunkListeners.forEach((listener) => listener(combined));
}

/** Feeds a chunk of the host's recorded audio into that room's relay, starting ffmpeg lazily on first use. */
export function pushChunk(code: string, chunk: Buffer) {
  const upperCode = code.toUpperCase();
  const existed = relays.has(upperCode);
  const relay = relays.get(upperCode) ?? startRelay(upperCode);
  if (!existed) console.log(`[audio-relay:${upperCode}] first chunk received (${chunk.length} bytes)`);
  if (relay.ffmpeg.stdin.writable) {
    relay.ffmpeg.stdin.write(chunk);
  } else {
    console.warn(`[audio-relay:${upperCode}] stdin not writable, dropped chunk`);
  }
}

/** Tears down a room's relay (host stopped sharing, or left/disconnected). */
export function stopRelay(code: string) {
  const upperCode = code.toUpperCase();
  const relay = relays.get(upperCode);
  if (!relay) return;
  clearInterval(relay.socketFlushTimer);
  relay.ffmpeg.stdin.end();
  relay.ffmpeg.kill("SIGKILL");
  relays.delete(upperCode);

  const pending = pendingSubscribers.get(upperCode);
  if (pending) {
    pending.forEach((res) => res.end());
    pendingSubscribers.delete(upperCode);
  }
  pendingChunkListeners.delete(upperCode);
}

/**
 * Registers an HTTP response as a live subscriber for a room's relay. If the
 * host hasn't started sending audio yet, queues the response so it attaches
 * as soon as the relay spins up, giving up after a short timeout.
 */
export function subscribe(code: string, res: ServerResponse) {
  const upperCode = code.toUpperCase();
  const relay = relays.get(upperCode);

  if (relay) {
    if (relay.initSegment) res.write(relay.initSegment);
    relay.subscribers.add(res);
    console.log(`[audio-relay:${upperCode}] HTTP subscriber attached (${relay.subscribers.size} total)`);
    res.on("close", () => relay.subscribers.delete(res));
    return;
  }

  console.log(`[audio-relay:${upperCode}] HTTP subscriber queued (no relay yet)`);
  let pending = pendingSubscribers.get(upperCode);
  if (!pending) {
    pending = new Set();
    pendingSubscribers.set(upperCode, pending);
  }
  pending.add(res);

  const timeout = setTimeout(() => {
    if (pending?.has(res)) {
      pending.delete(res);
      if (!res.writableEnded) res.end();
    }
  }, PENDING_SUBSCRIBER_TIMEOUT_MS);

  res.on("close", () => {
    pending?.delete(res);
    clearTimeout(timeout);
  });
}

/**
 * Registers a callback that gets invoked with combined fragment chunks
 * roughly every SOCKET_CHUNK_FLUSH_MS, for delivery over a listener's own
 * Socket.IO connection instead of a separate HTTP stream. If the relay
 * already has a cached init segment (i.e. it's been running a while), that's
 * delivered to this listener immediately so a MediaSource SourceBuffer on
 * their end has what it needs before any fragment arrives. Returns an
 * unsubscribe function. If the relay doesn't exist yet at all, queues the
 * listener so it attaches as soon as the host's first chunk starts one.
 */
export function onChunk(code: string, listener: ChunkListener): () => void {
  const upperCode = code.toUpperCase();
  const relay = relays.get(upperCode);

  if (relay) {
    if (relay.initSegment) listener(relay.initSegment);
    relay.chunkListeners.add(listener);
    return () => relay.chunkListeners.delete(listener);
  }

  let pending = pendingChunkListeners.get(upperCode);
  if (!pending) {
    pending = new Set();
    pendingChunkListeners.set(upperCode, pending);
  }
  pending.add(listener);

  return () => {
    pendingChunkListeners.get(upperCode)?.delete(listener);
    relays.get(upperCode)?.chunkListeners.delete(listener);
  };
}

export function isRelayActive(code: string): boolean {
  return relays.has(code.toUpperCase());
}
