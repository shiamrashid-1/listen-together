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

export interface RoomState {
  code: string;
  hostId: string;
  participants: Participant[];
  queue: QueueTrack[];
  nowPlayingId: string | null;
  isSharing: boolean;
}

export interface SpotifyTrackResult {
  uri: string;
  name: string;
  artists: string;
  albumArt: string | null;
  durationMs: number;
}
