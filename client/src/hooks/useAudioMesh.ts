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
 * Chrome buffers incoming audio to smooth out network jitter. We previously
 * forced this buffer down to ~40ms for a snappier "live" feel, but that
 * removes the slack a real cross-network/cellular connection needs to
 * absorb jitter - on those links it caused enough dropped/late packets to
 * make audio choppy or fully silent, even though the connection looked
 * "connected." Chrome's default adaptive jitter buffer already balances
 * latency against the jitter it's actually observing per-connection, so we
 * only nudge it down a little instead of forcing it to a fixed floor - a
 * modest latency win on good networks, without starving playback on bad ones.
 */
function reduceReceiverLatency(receiver: RTCRtpReceiver) {
  const tunableReceiver = receiver as RTCRtpReceiver & {
    jitterBufferTarget?: number;
  };
  try {
    tunableReceiver.jitterBufferTarget = 150;
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

interface UseAudioMeshOptions {
  isHost: boolean;
  participants: Participant[];
  selfId: string | null;
  roomCode: string;
}

/**
 * Mesh WebRTC audio relay, with an HTTP-stream fallback for listeners whose
 * network blocks WebRTC entirely. The host captures tab/system audio via
 * getDisplayMedia, opens one RTCPeerConnection per listener carrying the
 * same captured track, and (always, in parallel) records that same audio
 * into a live MP3 relay on the server via `audio:chunk`. Listeners try
 * WebRTC first for low latency, and if it doesn't connect within
 * WEBRTC_FALLBACK_TIMEOUT_MS, switch to plain HTTP streaming instead - that
 * works over literally any network/browser, since it's indistinguishable
 * from loading a normal web page.
 */
export function useAudioMesh({ isHost, participants, selfId, roomCode }: UseAudioMeshOptions) {
  const [isSharing, setIsSharing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [audioFallbackUrl, setAudioFallbackUrl] = useState<string | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());

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

      await Promise.all(
        participants.filter((p) => p.id !== selfId).map((p) => connectToListener(p.id))
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

  // Host: connect to any listener that joins after sharing has already started.
  useEffect(() => {
    if (!isHost || !isSharing) return;
    participants
      .filter((p) => p.id !== selfId && !peersRef.current.has(p.id))
      .forEach((p) => connectToListener(p.id));

    const currentIds = new Set(participants.map((p) => p.id));
    peersRef.current.forEach((_pc, peerId) => {
      if (!currentIds.has(peerId)) closePeer(peerId);
    });
  }, [isHost, isSharing, participants, selfId, connectToListener, closePeer]);

  // Listener side: respond to offers from the host, relay ICE candidates.
  useEffect(() => {
    if (isHost) return;

    const handleOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      closePeer(from);
      setAudioFallbackUrl(null); // give WebRTC a fresh chance before falling back again

      const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
      peersRef.current.set(from, pc);

      const label = `listener<-${from.slice(0, 6)}`;
      const activateFallback = () => {
        if (peersRef.current.get(from) !== pc) return; // this peer's already been replaced/closed
        console.warn(`[webrtc:${label}] falling back to HTTP relay stream`);
        setAudioFallbackUrl(`${SERVER_URL}/api/audio/live/${roomCode}`);
      };
      const fallbackTimer = setTimeout(() => {
        if (pc.connectionState !== "connected") activateFallback();
      }, WEBRTC_FALLBACK_TIMEOUT_MS);

      logConnectionDiagnostics(pc, label, () => {
        if (pc.connectionState === "connected") {
          clearTimeout(fallbackTimer);
          setAudioFallbackUrl(null); // WebRTC came through after all - drop the fallback
        }
        if (pc.connectionState === "failed") activateFallback();
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

    socket.on("webrtc:offer", handleOffer);
    socket.on("webrtc:ice-candidate", handleIceCandidate);
    return () => {
      socket.off("webrtc:offer", handleOffer);
      socket.off("webrtc:ice-candidate", handleIceCandidate);
    };
  }, [isHost, closePeer, roomCode]);

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isSharing, captureError, remoteStream, audioFallbackUrl, startSharing, stopSharing };
}
