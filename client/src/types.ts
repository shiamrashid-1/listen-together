export interface Participant {
  id: string;
  name: string;
  isHost: boolean;
}

export interface QueueTrack {
  id: string;
  uri: string;
  name: string;
  artists: string;
  albumArt: string | null;
  durationMs: number;
  addedBy: string;
}

export interface NowPlaying {
  track: QueueTrack;
  startedAt: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
}

export interface RoomState {
  code: string;
  hostId: string;
  participants: Participant[];
  queue: QueueTrack[];
  nowPlaying: NowPlaying | null;
  isSharing: boolean;
  spotifyConnected: boolean;
  messages: ChatMessage[];
  skipVoterIds: string[];
  skipVotesRequired: number;
}

export interface SpotifyTrackResult {
  uri: string;
  name: string;
  artists: string;
  albumArt: string | null;
  durationMs: number;
}

/** A track as reported directly by Spotify's real playback/queue APIs. */
export interface SpotifyPlaybackTrack {
  name: string;
  artists: string;
  albumArt: string | null;
  durationMs: number;
  /** Who added this via our app's queue, if we were able to match it up - unset if it was queued directly in Spotify. */
  addedBy?: string;
}

export interface SpotifyPlaybackState {
  nowPlaying: {
    track: SpotifyPlaybackTrack;
    progressMs: number;
    isPlaying: boolean;
    fetchedAt: number;
  } | null;
  queue: SpotifyPlaybackTrack[];
}

/** Common shape the Now Playing card renders, regardless of where the data came from. */
export interface PlaybackInfo {
  track: {
    name: string;
    artists: string;
    albumArt: string | null;
    durationMs: number;
    addedBy?: string;
  };
  progressMs: number;
  isPlaying: boolean;
  fetchedAt: number;
}
