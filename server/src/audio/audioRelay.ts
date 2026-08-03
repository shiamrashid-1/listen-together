import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import ffmpegPath from "ffmpeg-static";

const PENDING_SUBSCRIBER_TIMEOUT_MS = 15000;
// How often buffered MP3 output gets flushed to socket-based subscribers, as
// one combined chunk. Bigger than the HTTP path's immediate per-byte
// forwarding on purpose: MP3 frames are independently decodable, but only if
// a chunk contains enough of them - very small/oddly-cut chunks decode
// inconsistently via the Web Audio API on the listener side.
const SOCKET_CHUNK_FLUSH_MS = 700;

type ChunkListener = (chunk: Buffer) => void;

interface RoomRelay {
  ffmpeg: ChildProcessWithoutNullStreams;
  subscribers: Set<ServerResponse>;
  chunkListeners: Set<ChunkListener>;
  socketBuffer: Buffer[];
  socketFlushTimer: NodeJS.Timeout;
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
 * Spawns a per-room ffmpeg process that transcodes the host's live webm/opus
 * chunks (fed via stdin) into a continuous MP3 stream (stdout), fanned out
 * two ways: as a plain HTTP byte stream (for <audio src>, which needs a
 * format any browser can play natively, including Safari/iOS which don't
 * support WebM at all), and as periodic binary chunks pushed over each
 * listener's existing Socket.IO connection (for networks that block
 * long-lived streaming HTTP connections outright but already allow that
 * WebSocket traffic through, since the rest of the app depends on it too).
 * MP3 is chosen for both because it's self-synchronizing - a decoder can
 * pick up mid-stream without a cached header, unlike webm's init segment.
 */
function startRelay(code: string): RoomRelay {
  const ffmpeg = spawn(ffmpegPath as unknown as string, [
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vn",
    "-acodec",
    "libmp3lame",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-f",
    "mp3",
    "pipe:1",
  ]);

  const relay: RoomRelay = {
    ffmpeg,
    subscribers: new Set(),
    chunkListeners: new Set(),
    socketBuffer: [],
    socketFlushTimer: setInterval(() => flushSocketBuffer(code, relay), SOCKET_CHUNK_FLUSH_MS),
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
    relay.subscribers.forEach((res) => {
      if (!res.writableEnded) res.write(chunk);
    });
    relay.socketBuffer.push(chunk);
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
 * Registers a callback that gets invoked with combined MP3 chunks roughly
 * every SOCKET_CHUNK_FLUSH_MS, for delivery over a listener's own
 * Socket.IO connection instead of a separate HTTP stream. Returns an
 * unsubscribe function. If the relay doesn't exist yet, queues the listener
 * so it attaches as soon as the host's first chunk starts one.
 */
export function onChunk(code: string, listener: ChunkListener): () => void {
  const upperCode = code.toUpperCase();
  const relay = relays.get(upperCode);

  if (relay) {
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
