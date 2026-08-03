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
  /** epoch ms when this track started playing - clients derive live progress from this. */
  startedAt: number;
}

export interface RoomState {
  code: string;
  hostId: string;
  participants: Participant[];
  /** Upcoming tracks only - the currently playing track lives in `nowPlaying`, not here. */
  queue: QueueTrack[];
  nowPlaying: NowPlaying | null;
  isSharing: boolean;
  spotifyConnected: boolean;
}
