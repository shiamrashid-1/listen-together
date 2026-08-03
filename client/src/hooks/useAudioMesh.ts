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

interface UseAudioMeshOptions {
  isHost: boolean;
  participants: Participant[];
  selfId: string | null;
}

/**
 * Mesh WebRTC audio relay. The host captures tab/system audio via
 * getDisplayMedia and opens one RTCPeerConnection per listener, all carrying
 * the same captured track. Listeners just receive a single incoming stream
 * from the host.
 */
export function useAudioMesh({ isHost, participants, selfId }: UseAudioMeshOptions) {
  const [isSharing, setIsSharing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
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
  }, [connectToListener, participants, selfId]);

  const stopSharing = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    closeAllPeers();
    setIsSharing(false);
    socket.emit("audio:sharing-stopped");
  }, [closeAllPeers]);

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
      const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
      peersRef.current.set(from, pc);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("webrtc:ice-candidate", { to: from, candidate: event.candidate });
        }
      };
      pc.ontrack = (event) => {
        reduceReceiverLatency(event.receiver);
        setRemoteStream(event.streams[0] ?? null);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
          setRemoteStream((prev) => (peersRef.current.get(from) === pc ? null : prev));
        }
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
  }, [isHost, closePeer]);

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
      closeAllPeers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isSharing, captureError, remoteStream, startSharing, stopSharing };
}
