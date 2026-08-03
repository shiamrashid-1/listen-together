import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useRoom } from "../context/RoomContext";
import { useAudioMesh } from "../hooks/useAudioMesh";
import { useSpotifyPlayback } from "../hooks/useSpotifyPlayback";
import { useChat } from "../hooks/useChat";
import RoomCode from "../components/RoomCode";
import ParticipantList from "../components/ParticipantList";
import AudioShare from "../components/AudioShare";
import SpotifyConnect from "../components/SpotifyConnect";
import TrackSearch from "../components/TrackSearch";
import NowPlayingCard from "../components/NowPlayingCard";
import Queue from "../components/Queue";
import ChatBox from "../components/ChatBox";
import type { ChatMessage, PlaybackInfo, QueueTrack } from "../types";

const EMPTY_MESSAGES: ChatMessage[] = [];

export default function Room() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const { room, selfId, leaveRoom } = useRoom();

  const inRoom = Boolean(room) && room?.code === code.toUpperCase();
  const isHost = inRoom && room ? room.hostId === selfId : false;
  const audioMesh = useAudioMesh({
    isHost,
    participants: inRoom && room ? room.participants : [],
    selfId,
  });
  const spotifyPlayback = useSpotifyPlayback(Boolean(room?.spotifyConnected));
  const { messages, sendMessage } = useChat(room?.messages ?? EMPTY_MESSAGES);

  if (!inRoom || !room) {
    return <JoinPrompt code={code} />;
  }

  // When the host has connected Spotify, real playback state (from Spotify
  // itself) takes over the display entirely - it reflects whatever's
  // actually playing/queued on their account, not just what was added
  // through our search box.
  const usingRealSpotify = room.spotifyConnected;
  const nowPlayingInfo: PlaybackInfo | null = usingRealSpotify
    ? spotifyPlayback?.nowPlaying
      ? {
          track: spotifyPlayback.nowPlaying.track,
          progressMs: spotifyPlayback.nowPlaying.progressMs,
          isPlaying: spotifyPlayback.nowPlaying.isPlaying,
          fetchedAt: spotifyPlayback.nowPlaying.fetchedAt,
        }
      : null
    : room.nowPlaying
    ? {
        track: room.nowPlaying.track,
        progressMs: 0,
        isPlaying: true,
        fetchedAt: room.nowPlaying.startedAt,
      }
    : null;

  const upNextTracks: QueueTrack[] = usingRealSpotify
    ? (spotifyPlayback?.queue ?? []).map((track, index) => ({
        id: `spotify-${index}`,
        uri: "",
        addedBy: "",
        ...track,
      }))
    : room.queue;

  const handleLeave = () => {
    audioMesh.stopSharing();
    leaveRoom();
    navigate("/");
  };

  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-7xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">
            Listen <span className="text-brand">Together</span>
          </h1>
          <button
            onClick={handleLeave}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/10"
          >
            Leave room
          </button>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-[300px_1fr] lg:grid-cols-[300px_1fr_320px]">
          <div className="space-y-6">
            <RoomCode code={room.code} />
            <AudioShare
              isHost={isHost}
              roomIsSharing={room.isSharing}
              isSharing={audioMesh.isSharing}
              captureError={audioMesh.captureError}
              remoteStream={audioMesh.remoteStream}
              startSharing={audioMesh.startSharing}
              stopSharing={audioMesh.stopSharing}
            />
            <ParticipantList participants={room.participants} selfId={selfId} isSharing={room.isSharing} />
            <SpotifyConnect
              isHost={isHost}
              roomCode={room.code}
              selfId={selfId}
              spotifyConnected={room.spotifyConnected}
            />
          </div>

          <div className="space-y-6">
            <NowPlayingCard
              playback={nowPlayingInfo}
              showSkip={!usingRealSpotify}
              emptyMessage={
                usingRealSpotify
                  ? "Nothing playing on Spotify right now."
                  : "Nothing queued yet - add a song below to get started."
              }
            />
            <TrackSearch />
            <Queue
              queue={upNextTracks}
              readOnly={usingRealSpotify}
              emptyMessage={
                usingRealSpotify
                  ? "Nothing in your Spotify queue right now."
                  : "Nothing queued up. Search above to add more."
              }
            />
            {usingRealSpotify ? (
              <p className="-mt-2 px-1 text-xs text-white/30">
                Now playing and up next reflect the host's real Spotify queue.
              </p>
            ) : null}
          </div>

          <div className="h-[70vh] min-h-[420px] lg:h-full">
            <ChatBox messages={messages} selfId={selfId} onSend={sendMessage} />
          </div>
        </div>
      </div>
    </div>
  );
}

function JoinPrompt({ code }: { code: string }) {
  const { joinRoom } = useRoom();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a display name first.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const room = await joinRoom(code, name);
      navigate(`/room/${room.code}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join that room.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur">
        <h1 className="text-2xl font-bold text-white">Join room {code.toUpperCase()}</h1>
        <p className="mt-2 text-sm text-white/60">Enter a display name to join this room.</p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <input
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white placeholder-white/30 outline-none focus:border-brand"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            autoFocus
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-brand py-2.5 font-semibold text-black transition hover:brightness-110 disabled:opacity-50"
          >
            {isSubmitting ? "Joining…" : "Join room"}
          </button>
        </form>
      </div>
    </div>
  );
}
