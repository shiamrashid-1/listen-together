import { useEffect, useRef, useState } from "react";
import { isDisplayCaptureSupported } from "../hooks/useAudioMesh";

interface AudioShareProps {
  isHost: boolean;
  roomIsSharing: boolean;
  isSharing: boolean;
  captureError: string | null;
  remoteStream: MediaStream | null;
  fallbackActive: boolean;
  fallbackNeedsResume: boolean;
  resumeFallbackAudio: () => void;
  startSharing: () => void;
  stopSharing: () => void;
}

export default function AudioShare({
  isHost,
  roomIsSharing,
  isSharing,
  captureError,
  remoteStream,
  fallbackActive,
  fallbackNeedsResume,
  resumeFallbackAudio,
  startSharing,
  stopSharing,
}: AudioShareProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [needsPlaybackTap, setNeedsPlaybackTap] = useState(false);

  // WebRTC (remoteStream) plays through a plain <audio> element. The
  // socket-relayed fallback instead plays via the Web Audio API directly
  // (see LiveAudioPlayer in useAudioMesh) - nothing to wire up here besides
  // clearing the element when it's not needed.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    if (remoteStream) {
      el.removeAttribute("src");
      el.srcObject = remoteStream;
      el.play().catch(() => setNeedsPlaybackTap(true));
      return;
    }

    el.srcObject = null;
    el.removeAttribute("src");
  }, [remoteStream]);

  if (isHost) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-white/50">Your audio</p>
        <p className="mt-1 text-sm text-white/60">
          Share your browser tab playing Spotify (open{" "}
          <span className="text-white/80">open.spotify.com</span> in another tab) and everyone in
          the room will hear it live.
        </p>

        {!isDisplayCaptureSupported && (
          <p className="mt-3 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-300">
            Your browser doesn't support tab audio capture. Try the latest Chrome or Edge.
          </p>
        )}

        {captureError && (
          <p className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{captureError}</p>
        )}

        <button
          onClick={isSharing ? stopSharing : startSharing}
          disabled={!isDisplayCaptureSupported}
          className={`mt-4 w-full rounded-lg py-2.5 font-semibold transition disabled:opacity-40 ${
            isSharing ? "bg-red-500/90 text-white hover:brightness-110" : "bg-brand text-black hover:brightness-110"
          }`}
        >
          {isSharing ? "Stop sharing audio" : "Share my audio"}
        </button>

        {isSharing && (
          <p className="mt-3 text-xs text-white/50">
            When the browser prompt appears, choose the Spotify tab and tick <b>“Share tab audio”</b>.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">Room audio</p>
      <audio ref={audioRef} autoPlay />
      {roomIsSharing ? (
        remoteStream ? (
          needsPlaybackTap ? (
            <button
              onClick={() => {
                audioRef.current?.play();
                setNeedsPlaybackTap(false);
              }}
              className="mt-3 w-full rounded-lg bg-brand py-2.5 font-semibold text-black transition hover:brightness-110"
            >
              Tap to listen
            </button>
          ) : (
            <p className="mt-2 flex items-center gap-2 text-sm text-brand">
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand" />
              Listening live
            </p>
          )
        ) : fallbackActive ? (
          fallbackNeedsResume ? (
            <button
              onClick={resumeFallbackAudio}
              className="mt-3 w-full rounded-lg bg-brand py-2.5 font-semibold text-black transition hover:brightness-110"
            >
              Tap to listen
            </button>
          ) : (
            <div className="mt-2 space-y-1">
              <p className="flex items-center gap-2 text-sm text-amber-300">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
                Listening (backup stream)
              </p>
              <p className="text-xs text-white/50">
                Your network is blocking the direct connection, so audio is running a few seconds
                behind live.
              </p>
            </div>
          )
        ) : (
          <p className="mt-2 text-sm text-white/60">Connecting to the host's audio…</p>
        )
      ) : (
        <p className="mt-2 text-sm text-white/60">The host isn't sharing audio yet.</p>
      )}
    </div>
  );
}
