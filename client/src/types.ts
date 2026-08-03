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

export interface RoomState {
  code: string;
  hostId: string;
  participants: Participant[];
  queue: QueueTrack[];
  nowPlaying: NowPlaying | null;
  isSharing: boolean;
  spotifyConnected: boolean;
}

export interface SpotifyTrackResult {
  uri: string;
  name: string;
  artists: string;
  albumArt: string | null;
  durationMs: number;
}
