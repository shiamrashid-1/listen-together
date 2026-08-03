import { useState } from "react";
import { SERVER_URL } from "../lib/socket";

interface SpotifyConnectProps {
  isHost: boolean;
  roomCode: string;
  selfId: string | null;
  spotifyConnected: boolean;
}

export default function SpotifyConnect({ isHost, roomCode, selfId, spotifyConnected }: SpotifyConnectProps) {
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  if (!isHost) {
    return spotifyConnected ? (
      <p className="text-xs text-white/40">Host's Spotify is connected — added songs also queue live.</p>
    ) : null;
  }

  const connect = () => {
    if (!selfId) return;
    const url = `${SERVER_URL}/api/spotify/login?code=${roomCode}&socketId=${encodeURIComponent(selfId)}`;
    window.open(url, "spotify-oauth", "width=480,height=720");
  };

  const disconnect = async () => {
    if (!selfId) return;
    setIsDisconnecting(true);
    try {
      await fetch(`${SERVER_URL}/api/spotify/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: roomCode, socketId: selfId }),
      });
    } finally {
      setIsDisconnecting(false);
    }
  };

  if (spotifyConnected) {
    return (
      <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
        <p className="flex items-center gap-2 text-sm text-brand">
          <span className="h-2 w-2 rounded-full bg-brand" />
          Spotify connected
        </p>
        <button
          onClick={disconnect}
          disabled={isDisconnecting}
          className="text-xs text-white/50 underline-offset-2 transition hover:text-white/80 hover:underline disabled:opacity-40"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-white/50">Real Spotify queue</p>
      <p className="mt-1 text-sm text-white/60">
        Connect your Spotify account so songs added to the queue also get pushed straight onto your
        Spotify player. Requires Spotify Premium and an active playback session.
      </p>
      <button
        onClick={connect}
        className="mt-4 w-full rounded-lg border border-white/10 py-2.5 font-semibold text-white/80 transition hover:bg-brand hover:text-black"
      >
        Connect Spotify
      </button>
    </div>
  );
}
