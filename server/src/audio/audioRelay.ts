import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import ffmpegPath from "ffmpeg-static";

const PENDING_SUBSCRIBER_TIMEOUT_MS = 15000;

interface RoomRelay {
  ffmpeg: ChildProcessWithoutNullStreams;
  subscribers: Set<ServerResponse>;
}

const relays = new Map<string, RoomRelay>();
// Listeners that asked to subscribe before the host's first audio chunk
// arrived (and therefore before ffmpeg exists yet) - attached once it starts.
const pendingSubscribers = new Map<string, Set<ServerResponse>>();

function attachPendingSubscribers(code: string, relay: RoomRelay) {
  const pending = pendingSubscribers.get(code);
  if (!pending) return;
  pending.forEach((res) => relay.subscribers.add(res));
  pendingSubscribers.delete(code);
}

/**
 * Spawns a per-room ffmpeg process that transcodes the host's live webm/opus
 * chunks (fed via stdin) into a continuous MP3 stream (stdout), which gets
 * fanned out to every HTTP subscriber currently listening for that room.
 *
 * MP3 is deliberately chosen over relaying the raw webm/opus bytes: it's
 * self-synchronizing (a decoder can start mid-stream without needing a
 * cached header, unlike webm's init segment) and plays natively via a plain
 * <audio src> in every browser, including Safari/iOS, which don't support
 * WebM at all - the whole point of this path is universal compatibility.
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

  const relay: RoomRelay = { ffmpeg, subscribers: new Set() };
  relays.set(code, relay);
  attachPendingSubscribers(code, relay);

  ffmpeg.stdout.on("data", (chunk: Buffer) => {
    relay.subscribers.forEach((res) => {
      if (!res.writableEnded) res.write(chunk);
    });
  });

  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    console.error(`[audio-relay:${code}] ffmpeg: ${chunk.toString().trim()}`);
  });

  ffmpeg.on("error", (err) => {
    console.error(`[audio-relay:${code}] ffmpeg failed to start:`, err);
  });

  ffmpeg.on("exit", (exitCode) => {
    console.log(`[audio-relay:${code}] ffmpeg exited (${exitCode})`);
    relay.subscribers.forEach((res) => {
      if (!res.writableEnded) res.end();
    });
    relay.subscribers.clear();
    if (relays.get(code) === relay) relays.delete(code);
  });

  return relay;
}

/** Feeds a chunk of the host's recorded audio into that room's relay, starting ffmpeg lazily on first use. */
export function pushChunk(code: string, chunk: Buffer) {
  const upperCode = code.toUpperCase();
  const relay = relays.get(upperCode) ?? startRelay(upperCode);
  if (relay.ffmpeg.stdin.writable) {
    relay.ffmpeg.stdin.write(chunk);
  }
}

/** Tears down a room's relay (host stopped sharing, or left/disconnected). */
export function stopRelay(code: string) {
  const upperCode = code.toUpperCase();
  const relay = relays.get(upperCode);
  if (!relay) return;
  relay.ffmpeg.stdin.end();
  relay.ffmpeg.kill("SIGKILL");
  relays.delete(upperCode);

  const pending = pendingSubscribers.get(upperCode);
  if (pending) {
    pending.forEach((res) => res.end());
    pendingSubscribers.delete(upperCode);
  }
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
    res.on("close", () => relay.subscribers.delete(res));
    return;
  }

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

export function isRelayActive(code: string): boolean {
  return relays.has(code.toUpperCase());
}
