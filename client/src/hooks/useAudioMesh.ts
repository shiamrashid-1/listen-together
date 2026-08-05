import { useCallback, useEffect, useRef, useState } from "react";
import { SERVER_URL, socket } from "../lib/socket";
import type { Participant } from "../types";

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

let cachedIceServers: RTCIceServer[] | null = null;

/**
 * Fetches the current ICE server set (STUN + TURN, if the server has a TURN
 * key configured) once and reuses it for every peer connection in this tab.
 * Falls back to public STUN-only if the request fails.
 */
async function getIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers) return cachedIceServers;
  try {
    const res = await fetch(`${SERVER_URL}/api/ice-servers`);
    if (!res.ok) throw new Error(`ICE servers request failed (${res.status})`);
    const data = (await res.json()) as { iceServers: RTCIceServer[] };
    cachedIceServers = data.iceServers.length > 0 ? data.iceServers : FALLBACK_ICE_SERVERS;
  } catch (err) {
    console.error("[webrtc] couldn't fetch ICE servers, falling back to STUN-only:", err);
    cachedIceServers = FALLBACK_ICE_SERVERS;
  }
  return cachedIceServers;
}

export const isDisplayCaptureSupported =
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);

/**
 * How long a listener waits for WebRTC to reach "connected" before falling
 * back to the HTTP relay stream. Generous on purpose - most connections that
 * are going to succeed do so within a couple seconds, but TURN relay
 * negotiation on a slow network can legitimately take a few seconds longer.
 */
const WEBRTC_FALLBACK_TIMEOUT_MS = 8000;

/** How often the host emits a recorded audio chunk for the HTTP relay fallback. */
const RECORDER_CHUNK_INTERVAL_MS = 500;

/**
 * Caps how many direct WebRTC connections the host opens at once. Each mesh
 * connection is a separate ~96kbps Opus upload from the host's single
 * connection (plus its own DTLS/SRTP/ICE/RTCP overhead) - past a handful of
 * simultaneous connections, that easily saturates a typical home uplink,
 * causing packet loss/jitter across *every* connection at once (audio
 * stuttering for everyone, not just the newest listeners). 8 * ~96kbps is
 * comfortably under typical home upload bandwidth. Listeners beyond this
 * cap use the server relay instead (see LiveAudioPlayer below) - its
 * fan-out cost is paid by the server's bandwidth, not the host's.
 */
const MAX_MESH_LISTENERS = 8;

/**
 * Returns the IDs of participants who should get a direct WebRTC connection
 * from the host, in join order (host excluded). Both the host and every
 * listener compute this independently from the same `participants` array,
 * so no extra signaling is needed to agree on who's "in the mesh."
 *
 * Join order is stable and only ever improves a listener's rank (moving up
 * if someone ahead of them leaves) - new joiners are always appended, so
 * nobody already meshed ever gets bumped down to the relay just because the
 * room grew.
 */
function getMeshEligibleIds(participants: Participant[]): Set<string> {
  return new Set(
    participants
      .filter((p) => !p.isHost)
      .slice(0, MAX_MESH_LISTENERS)
      .map((p) => p.id)
  );
}

/**
 * Chrome negotiates mono, modest-bitrate Opus by default, which is tuned for
 * voice calls, not music. This rewrites the offer's Opus fmtp line to request
 * stereo and a somewhat higher bitrate for better music fidelity.
 *
 * Kept deliberately moderate (96kbps, not the ~192kbps we tried initially):
 * a bitrate that's fine on the same WiFi network can be too much to sustain
 * over a weaker/cellular cross-network link (especially relayed through
 * TURN), causing packet loss that presents as choppy or fully silent audio -
 * worse than the plain quality bump was meant to fix.
 */
function preferHighQualityOpus(sdp: string): string {
  const opusPayload = sdp.match(/a=rtpmap:(\d+) opus\/48000/)?.[1];
  if (!opusPayload) return sdp;

  const fmtpLine = new RegExp(`a=fmtp:${opusPayload} .*`);
  const qualityParams = "stereo=1;sprop-stereo=1;maxaveragebitrate=96000;maxplaybackrate=48000";

  if (fmtpLine.test(sdp)) {
    return sdp.replace(fmtpLine, (line) => {
      const params = line
        .replace(`a=fmtp:${opusPayload} `, "")
        .split(";")
        .filter((p) => !/^(stereo|sprop-stereo|maxaveragebitrate|maxplaybackrate)=/.test(p));
      return `a=fmtp:${opusPayload} ${[...params, qualityParams].join(";")}`;
    });
  }

  return sdp.replace(
    new RegExp(`(a=rtpmap:${opusPayload} opus/48000/2\\r?\\n)`),
    `$1a=fmtp:${opusPayload} ${qualityParams}\r\n`
  );
}

/**
 * Chrome buffers incoming audio to smooth out network jitter. Bigger rooms
 * (10-30+ people) see more stuttering even within the direct-mesh cap,
 * mainly from ordinary per-listener network jitter rather than the host's
 * bandwidth - the fix for that is more absorbing buffer, not less. This
 * trades a bit more latency (listeners hear audio ~1/4s later) for a much
 * larger cushion against late/reordered packets before anything audibly
 * drops out.
 */
function reduceReceiverLatency(receiver: RTCRtpReceiver) {
  const tunableReceiver = receiver as RTCRtpReceiver & {
    jitterBufferTarget?: number;
  };
  try {
    tunableReceiver.jitterBufferTarget = 300;
  } catch {
    // Non-Chrome browsers may not support this - safe to ignore.
  }
}

/**
 * Wires up console diagnostics for a peer connection so connection failures
 * (usually NAT/firewall traversal on stricter networks) leave a clear trail.
 * `label` identifies which peer/direction this is in a multi-peer mesh.
 */
function logConnectionDiagnostics(pc: RTCPeerConnection, label: string, onStateChange?: () => void) {
  pc.oniceconnectionstatechange = () => {
    console.log(`[webrtc:${label}] ICE connection state -> ${pc.iceConnectionState}`);
  };
  pc.onicegatheringstatechange = () => {
    console.log(`[webrtc:${label}] ICE gathering state -> ${pc.iceGatheringState}`);
  };
  pc.onicecandidateerror = (event) => {
    const e = event as RTCPeerConnectionIceErrorEvent;
    // errorCode 701 = STUN/TURN server unreachable, 401/403 = bad TURN credentials.
    console.warn(`[webrtc:${label}] ICE candidate error ${e.errorCode} on ${e.url}: ${e.errorText}`);
  };
  pc.onconnectionstatechange = () => {
    console.log(`[webrtc:${label}] connection state -> ${pc.connectionState}`);
    if (pc.connectionState === "connected") logSelectedCandidatePair(pc, label);
    onStateChange?.();
  };
}

/** Logs which ICE candidate pair (host/srflx/relay on each side) actually got used. */
async function logSelectedCandidatePair(pc: RTCPeerConnection, label: string) {
  try {
    const stats = await pc.getStats();
    stats.forEach((report) => {
      if (report.type !== "candidate-pair" || report.state !== "succeeded") return;
      const local = stats.get(report.localCandidateId) as { candidateType?: string } | undefined;
      const remote = stats.get(report.remoteCandidateId) as { candidateType?: string } | undefined;
      console.log(
        `[webrtc:${label}] using ${local?.candidateType ?? "?"} -> ${remote?.candidateType ?? "?"} candidate pair`
      );
    });
  } catch {
    // getStats() shouldn't normally throw, but this is purely diagnostic - ignore failures.
  }
}

/** The codec string the server's ffmpeg relay actually produces (see audioRelay.ts). */
const RELAY_MIME_TYPE = 'audio/mp4; codecs="mp4a.40.2"';

/**
 * How much buffered-ahead audio to wait for before starting playback. This
 * is purely a smoother-start nicety, not a correctness requirement: once
 * playing, MediaSource handles a slow/late fragment by pausing and
 * resuming on its own (the "waiting"/native buffering behavior every video
 * site relies on) with no click or glitch, unlike decoding independent
 * chunks by hand. A bit of lead just avoids an near-immediate stall right
 * out of the gate on a slow network.
 */
const RELAY_STARTUP_BUFFER_SECONDS = 1;

/**
 * Plays the continuous fragmented-MP4/AAC stream produced by the server's
 * ffmpeg relay through MediaSource Extensions, appending each delivered
 * chunk to a SourceBuffer as it arrives.
 *
 * This exists for listeners whose network blocks long-lived streaming HTTP
 * connections outright (some proxies/firewalls specifically flag and kill
 * those, even while allowing the very same domain's normal API/WebSocket
 * traffic through). Chunks arrive as binary Socket.IO events over the
 * already-connected, already-proven WebSocket instead of a separate HTTP
 * stream, so it stays viable anywhere the rest of the app already works.
 *
 * MSE (rather than decoding each delivered chunk independently via
 * decodeAudioData, as an earlier version did) is specifically what makes
 * this gapless: independently decoding arbitrary byte-range fragments loses
 * or mis-syncs the partial frame at each chunk boundary, which is exactly
 * what caused periodic "cutting"/glitchy-overlap artifacts once per chunk.
 * MSE keeps one continuous decode timeline across every appended fragment,
 * so there's no per-chunk boundary to glitch at - the browser's own
 * streaming-media pipeline (the same one every video site relies on) does
 * the gapless stitching for us.
 */
class LiveAudioPlayer {
  private audio: HTMLAudioElement;
  private mediaSource: MediaSource;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private startedPlayback = false;
  private mseUnsupported = false;

  constructor() {
    this.audio = document.createElement("audio");
    this.audio.style.display = "none";
    document.body.appendChild(this.audio);

    if (!MediaSource.isTypeSupported(RELAY_MIME_TYPE)) {
      console.error(`[audio] MediaSource doesn't support ${RELAY_MIME_TYPE} in this browser`);
      this.mseUnsupported = true;
      this.mediaSource = new MediaSource(); // placeholder; never opened
      return;
    }

    this.mediaSource = new MediaSource();
    this.audio.src = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener("sourceopen", () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(RELAY_MIME_TYPE);
        this.sourceBuffer.addEventListener("updateend", () => {
          this.maybeStartPlayback();
          this.pump();
        });
        this.pump();
      } catch (err) {
        console.error("[audio] MSE addSourceBuffer failed:", err);
      }
    });
  }

  get needsResume(): boolean {
    return this.audio.paused && this.startedPlayback;
  }

  resume(): Promise<void> {
    return this.audio.play();
  }

  pushChunk(chunk: ArrayBuffer) {
    if (this.mseUnsupported) return;
    this.queue.push(chunk);
    this.pump();
  }

  private pump() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      this.sourceBuffer.appendBuffer(next);
    } catch (err) {
      console.error("[audio] MSE appendBuffer failed:", err);
    }
  }

  private maybeStartPlayback() {
    if (this.startedPlayback || !this.sourceBuffer) return;
    const buffered = this.sourceBuffer.buffered;
    if (buffered.length === 0) return;
    const bufferedAhead = buffered.end(buffered.length - 1) - this.audio.currentTime;
    if (bufferedAhead < RELAY_STARTUP_BUFFER_SECONDS) return;
    this.startedPlayback = true;
    this.audio.play().catch(() => {
      // Autoplay may be blocked until a user gesture - resumeFallbackAudio()
      // (triggered from a click in the UI) retries this.
    });
  }

  close() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.remove();
  }
}

interface UseAudioMeshOptions {
  isHost: boolean;
  participants: Participant[];
  selfId: string | null;
  /** Whether the host currently has audio sharing turned on for this room. */
  roomIsSharing: boolean;
}

/**
 * Mesh WebRTC audio relay, with a Socket.IO-delivered fallback for listeners
 * whose network blocks WebRTC entirely. The host captures tab/system audio
 * via getDisplayMedia, opens one RTCPeerConnection per listener carrying the
 * same captured track, and (always, in parallel) records that same audio
 * into a live MP3 relay on the server via `audio:chunk`. Listeners try
 * WebRTC first for low latency, and if it doesn't connect within
 * WEBRTC_FALLBACK_TIMEOUT_MS, subscribe to that relay's output as binary
 * chunks over their existing socket connection instead - the same
 * connection already carrying room state/chat/signaling, so it keeps
 * working even on networks that block dedicated streaming HTTP connections.
 */
export function useAudioMesh({ isHost, participants, selfId, roomIsSharing }: UseAudioMeshOptions) {
  const [isSharing, setIsSharing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [fallbackActive, setFallbackActive] = useState(false);
  const [fallbackNeedsResume, setFallbackNeedsResume] = useState(false);
  const [fallbackReason, setFallbackReason] = useState<"network" | "capacity" | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const fallbackPlayerRef = useRef<LiveAudioPlayer | null>(null);
  const fallbackSubscribedRef = useRef(false);

  const resumeFallbackAudio = useCallback(() => {
    fallbackPlayerRef.current?.resume().then(
      () => setFallbackNeedsResume(false),
      () => setFallbackNeedsResume(true)
    );
  }, []);

  // Lifted out of the offer-handling effect so both the "WebRTC didn't
  // connect in time" path and the "we're outside the mesh cap, don't even
  // wait for an offer" path can share the same activation/teardown logic.
  const activateFallback = useCallback((reason: "network" | "capacity") => {
    if (fallbackSubscribedRef.current) {
      setFallbackReason(reason);
      return;
    }
    fallbackSubscribedRef.current = true;
    console.warn(`[audio] falling back to socket-relayed audio stream (reason: ${reason})`);
    const player = fallbackPlayerRef.current ?? new LiveAudioPlayer();
    fallbackPlayerRef.current = player;
    player.resume().catch(() => {});
    setFallbackNeedsResume(player.needsResume);
    socket.emit("audio:relay-subscribe");
    setFallbackActive(true);
    setFallbackReason(reason);
  }, []);

  const deactivateFallback = useCallback(() => {
    if (!fallbackSubscribedRef.current) return;
    fallbackSubscribedRef.current = false;
    socket.emit("audio:relay-unsubscribe");
    setFallbackActive(false);
    setFallbackNeedsResume(false);
    setFallbackReason(null);
  }, []);

  const closePeer = useCallback((peerId: string) => {
    const pc = peersRef.current.get(peerId);
    if (pc) {
      pc.close();
      peersRef.current.delete(peerId);
    }
  }, []);

  const closeAllPeers = useCallback(() => {
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
  }, []);

  const connectToListener = useCallback(
    async (listenerId: string) => {
      const localStream = localStreamRef.current;
      if (!localStream || peersRef.current.has(listenerId)) return;

      const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
      peersRef.current.set(listenerId, pc);
      logConnectionDiagnostics(pc, `host->${listenerId.slice(0, 6)}`);

      localStream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("webrtc:ice-candidate", { to: listenerId, candidate: event.candidate });
        }
      };

      const offer = await pc.createOffer();
      if (offer.sdp) offer.sdp = preferHighQualityOpus(offer.sdp);
      await pc.setLocalDescription(offer);
      socket.emit("webrtc:offer", { to: listenerId, sdp: offer });
    },
    []
  );

  /**
   * Always-on alongside WebRTC (not just when a listener needs it) - we
   * can't predict in advance which listener's network will need the
   * fallback, so the host streams to the relay unconditionally and it's
   * simply left unused if nobody ends up needing it.
   */
  const startRecordingForFallback = useCallback((stream: MediaStream) => {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      console.warn("[audio] MediaRecorder/webm-opus unsupported - HTTP relay fallback won't be available");
      return;
    }
    try {
      // Record from a fresh audio-only MediaStream, not the original capture
      // stream - that one still carries its (stopped) video track, and some
      // browsers reject/misbehave when an audio-only mimeType is paired with
      // a stream that still lists a video track, even a stopped one.
      const audioOnlyStream = new MediaStream(stream.getAudioTracks());
      const recorder = new MediaRecorder(audioOnlyStream, {
        mimeType: "audio/webm;codecs=opus",
        audioBitsPerSecond: 128000,
      });
      let chunksSent = 0;
      recorder.ondataavailable = async (event) => {
        if (event.data.size === 0) return;
        socket.emit("audio:chunk", await event.data.arrayBuffer());
        chunksSent += 1;
        if (chunksSent === 1) console.log("[audio] relay recorder sending chunks to server");
      };
      recorder.onerror = (event) => console.error("[audio] relay recorder error:", event);
      recorder.start(RECORDER_CHUNK_INTERVAL_MS);
      mediaRecorderRef.current = recorder;
      console.log("[audio] relay recorder started");
    } catch (err) {
      console.error("[audio] couldn't start relay recorder:", err);
    }
  }, []);

  const stopRecordingForFallback = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  const startSharing = useCallback(async () => {
    setCaptureError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          // These default to "on" for voice calls but actively hurt music:
          // echo cancellation smears transients, noise suppression/AGC
          // squash dynamics and can duck the whole track.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        } as MediaTrackConstraints,
      });

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        setCaptureError(
          "No audio was captured. When prompted, pick the Spotify tab (not 'Entire Screen') and make sure to tick 'Share tab audio'."
        );
        return;
      }

      // We only need the audio - drop the video track immediately.
      stream.getVideoTracks().forEach((track) => track.stop());
      localStreamRef.current = stream;

      audioTracks[0].addEventListener("ended", () => {
        stopSharing();
      });

      const meshEligibleIds = getMeshEligibleIds(participants);
      await Promise.all(
        participants
          .filter((p) => p.id !== selfId && meshEligibleIds.has(p.id))
          .map((p) => connectToListener(p.id))
      );

      startRecordingForFallback(stream);
      socket.emit("audio:sharing-started");
      setIsSharing(true);
    } catch (err) {
      console.error("[audio] capture failed", err);
      setCaptureError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Permission to capture audio was denied."
          : "Couldn't start audio sharing. Try again, or use Chrome/Edge for best support."
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectToListener, participants, selfId, startRecordingForFallback]);

  const stopSharing = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    closeAllPeers();
    stopRecordingForFallback();
    setIsSharing(false);
    socket.emit("audio:sharing-stopped");
  }, [closeAllPeers, stopRecordingForFallback]);

  // Host: connect to any mesh-eligible listener that joins (or becomes
  // eligible, e.g. a slot freed up) after sharing has already started.
  useEffect(() => {
    if (!isHost || !isSharing) return;
    const meshEligibleIds = getMeshEligibleIds(participants);
    participants
      .filter((p) => p.id !== selfId && meshEligibleIds.has(p.id) && !peersRef.current.has(p.id))
      .forEach((p) => connectToListener(p.id));

    // Close peers that left the room entirely, or fell outside the current
    // participant set (cap changes don't demote anyone already meshed).
    const currentIds = new Set(participants.map((p) => p.id));
    peersRef.current.forEach((_pc, peerId) => {
      if (!currentIds.has(peerId)) closePeer(peerId);
    });
  }, [isHost, isSharing, participants, selfId, connectToListener, closePeer]);

  // Listener side: if we're outside the mesh cap, no offer is ever coming
  // for us - go straight to the relay instead of waiting around for one.
  // Recomputed whenever the participant list or sharing state changes (e.g.
  // a slot frees up ahead of us, or sharing stops entirely).
  useEffect(() => {
    if (isHost || !selfId) return;
    if (!roomIsSharing) {
      deactivateFallback();
      return;
    }
    if (!getMeshEligibleIds(participants).has(selfId)) activateFallback("capacity");
  }, [isHost, selfId, roomIsSharing, participants, activateFallback, deactivateFallback]);

  // Listener side: respond to offers from the host, relay ICE candidates.
  useEffect(() => {
    if (isHost) return;

    const handleOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      closePeer(from);
      deactivateFallback(); // give WebRTC a fresh chance before falling back again

      const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
      peersRef.current.set(from, pc);

      const label = `listener<-${from.slice(0, 6)}`;
      const fallbackTimer = setTimeout(() => {
        if (peersRef.current.get(from) === pc && pc.connectionState !== "connected") activateFallback("network");
      }, WEBRTC_FALLBACK_TIMEOUT_MS);

      logConnectionDiagnostics(pc, label, () => {
        if (pc.connectionState === "connected") {
          clearTimeout(fallbackTimer);
          deactivateFallback(); // WebRTC came through after all - drop the fallback
        }
        if (pc.connectionState === "failed" && peersRef.current.get(from) === pc) activateFallback("network");
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
          setRemoteStream((prev) => (peersRef.current.get(from) === pc ? null : prev));
        }
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("webrtc:ice-candidate", { to: from, candidate: event.candidate });
        }
      };
      pc.ontrack = (event) => {
        reduceReceiverLatency(event.receiver);
        setRemoteStream(event.streams[0] ?? null);
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("webrtc:answer", { to: from, sdp: answer });
    };

    const handleIceCandidate = ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peersRef.current.get(from);
      if (pc && candidate) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    };

    const handleRelayChunk = (chunk: ArrayBuffer) => {
      fallbackPlayerRef.current?.pushChunk(chunk);
    };

    socket.on("webrtc:offer", handleOffer);
    socket.on("webrtc:ice-candidate", handleIceCandidate);
    socket.on("audio:relay-chunk", handleRelayChunk);
    return () => {
      socket.off("webrtc:offer", handleOffer);
      socket.off("webrtc:ice-candidate", handleIceCandidate);
      socket.off("audio:relay-chunk", handleRelayChunk);
    };
  }, [isHost, closePeer, activateFallback, deactivateFallback]);

  // Host side: receive answers and ICE candidates from listeners.
  useEffect(() => {
    if (!isHost) return;

    const handleAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    };

    const handleIceCandidate = ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peersRef.current.get(from);
      if (pc && candidate) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    };

    socket.on("webrtc:answer", handleAnswer);
    socket.on("webrtc:ice-candidate", handleIceCandidate);
    return () => {
      socket.off("webrtc:answer", handleAnswer);
      socket.off("webrtc:ice-candidate", handleIceCandidate);
    };
  }, [isHost]);

  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current?.stop();
      closeAllPeers();
      if (fallbackSubscribedRef.current) socket.emit("audio:relay-unsubscribe");
      fallbackPlayerRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isSharing,
    captureError,
    remoteStream,
    fallbackActive,
    fallbackNeedsResume,
    fallbackReason,
    resumeFallbackAudio,
    startSharing,
    stopSharing,
  };
}
