export const EXTENSION_ID = "demonrider.cinematic-sync";

// Relative to each built HTML entry so local development and a GitHub Pages
// project subpath resolve to the same asset.
export const CINEMATIC_URL = "./assets/cinematic.mp4";
export const CINEMATIC_CACHE_VERSION = "v1";
export const CINEMATIC_CACHE_PREFIX = `${EXTENSION_ID}/media/`;
export const CINEMATIC_CACHE_NAME =
  `${CINEMATIC_CACHE_PREFIX}${CINEMATIC_CACHE_VERSION}`;

export type MusicTrackId = "o-porao" | "o-idolo";

export interface MusicTrackConfig {
  id: MusicTrackId;
  label: string;
  url: string;
  // Duração decodificada do asset final. O ciclo runtime é calculado
  // separadamente e não reutiliza o crossfade já incorporado ao arquivo.
  durationSeconds: number;
  loopPreparation: {
    sourceDurationSeconds: number;
    seamCrossfadeSeconds: number;
  };
}

export const MUSIC_TRACKS = [
  {
    id: "o-porao",
    label: "O Porão",
    url: "./assets/music/o-porao.ogg",
    durationSeconds: 314.860479167,
    loopPreparation: {
      sourceDurationSeconds: 326.860458333,
      seamCrossfadeSeconds: 12,
    },
  },
  {
    id: "o-idolo",
    label: "O Ídolo",
    url: "./assets/music/o-idolo.ogg",
    durationSeconds: 331.027291667,
    loopPreparation: {
      sourceDurationSeconds: 331.034479166,
      seamCrossfadeSeconds: 0.007208333,
    },
  },
] as const satisfies readonly MusicTrackConfig[];

export const DEFAULT_MUSIC_TRACK_ID: MusicTrackId = "o-porao";
export const MUSIC_ASSET_VERSION = "v1";
export const MUSIC_ROOM_METADATA_KEY = `${EXTENSION_ID}/music-state`;

export const MUSIC_COMMAND_DELAY_MS = 500;
export const MUSIC_TRACK_CROSSFADE_MS = 4_000;
export const MUSIC_LOOP_CROSSFADE_MS = 300;
export const MUSIC_CINEMATIC_FADE_OUT_MS = 500;
export const MUSIC_CINEMATIC_FADE_IN_MS = 700;
export const MUSIC_GAIN_STEP_MS = 40;
export const MUSIC_PRELOAD_TIMEOUT_MS = 2 * 60_000;
export const MUSIC_DRIFT_CHECK_INTERVAL_MS = 5_000;
export const MUSIC_DRIFT_TOLERANCE_SECONDS = 0.35;

export const CINEMATIC_MUSIC_SYNC = {
  trackId: "o-idolo",
  videoDurationSeconds: 39.125604167,
  sourcePositionAtVideoStartSeconds: 308.847,
  playerPositionAtVideoStartSeconds: 308.847,
  externalOverlapStartsAtVideoSeconds: 33.15,
  externalDominantAtVideoSeconds: 33.4,
  embeddedMusicEndsAtVideoSeconds: 33.85,
  sourcePositionAtHandoffSeconds: 11.669708333,
  playerPositionAtHandoffSeconds: 11.669708333,
  embeddedTrackGain: 0.480243,
  gainNormalizationEndsAtVideoSeconds: 35.125604167,
  fadeInMs: MUSIC_CINEMATIC_FADE_IN_MS,
} as const satisfies {
  trackId: MusicTrackId;
  videoDurationSeconds: number;
  sourcePositionAtVideoStartSeconds: number;
  playerPositionAtVideoStartSeconds: number;
  externalOverlapStartsAtVideoSeconds: number;
  externalDominantAtVideoSeconds: number;
  embeddedMusicEndsAtVideoSeconds: number;
  sourcePositionAtHandoffSeconds: number;
  playerPositionAtHandoffSeconds: number;
  embeddedTrackGain: number;
  gainNormalizationEndsAtVideoSeconds: number;
  fadeInMs: number;
};

export const CINEMATIC_OUTRO_MUSIC = {
  trackId: "o-porao",
  positionSeconds: 30.95,
  startsAtVideoSeconds: 35.125604167,
  durationMs: MUSIC_TRACK_CROSSFADE_MS,
  sourceTrackPositionAtStartSeconds: 12.9453125,
} as const satisfies {
  trackId: MusicTrackId;
  positionSeconds: number;
  startsAtVideoSeconds: number;
  durationMs: number;
  sourceTrackPositionAtStartSeconds: number;
};

export const CINEMATIC_OUTRO_CANDIDATES = [
  {
    positionSeconds: 30.95,
    score: 0.363416,
    rmsDbfs: -12.9011,
    transientDb: 0.8039,
    spectralDistance: 0.195854,
    chromaSimilarity: 0.813617,
  },
  {
    positionSeconds: 63.3,
    score: 0.370201,
    rmsDbfs: -12.5534,
    transientDb: 0.8813,
    spectralDistance: 0.219849,
    chromaSimilarity: 0.685495,
  },
  {
    positionSeconds: 204.6,
    score: 0.425896,
    rmsDbfs: -15.5642,
    transientDb: 0.4704,
    spectralDistance: 0.14064,
    chromaSimilarity: 0.84167,
  },
] as const;

export const PROTOCOL_VERSION = 2;
export const BROADCAST_CHANNEL = `${EXTENSION_ID}/protocol/v${PROTOCOL_VERSION}`;

export const TOOL_ID = `${EXTENSION_ID}/tool`;
export const CONTROL_POPOVER_ID = `${EXTENSION_ID}/controls`;
export const CINEMATIC_MODAL_ID = `${EXTENSION_ID}/cinematic`;

export const PLAY_START_DELAY_MS = 1_500;
export const FADE_IN_MS = 600;
export const FADE_OUT_MS = 700;
export const PRELOAD_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const MEDIA_PROBE_TIMEOUT_MS = 30_000;
export const MODAL_PREPARE_TIMEOUT_MS = 30_000;
export const PLAYBACK_WATCHDOG_GRACE_MS = 15_000;
export const MODAL_CLOSE_RETRY_MS = 250;

export const CLOCK_SYNC_SAMPLE_COUNT = 3;
export const CLOCK_SYNC_SAMPLE_INTERVAL_MS = 300;
export const STATUS_REFRESH_INTERVAL_MS = 5_000;

export function resolveAppUrl(relativeUrl: string): string {
  return new URL(relativeUrl, window.location.href).href;
}

export function getCinematicRequestUrl(): string {
  const url = new URL(CINEMATIC_URL, window.location.href);
  url.searchParams.set("cinematic-cache", CINEMATIC_CACHE_VERSION);
  return url.href;
}

export function getMusicTrackConfig(trackId: MusicTrackId): MusicTrackConfig {
  const track = MUSIC_TRACKS.find((candidate) => candidate.id === trackId);
  if (!track) {
    throw new Error(`Faixa musical desconhecida: ${trackId}`);
  }
  return track;
}

export function getMusicLoopCycleSeconds(trackId: MusicTrackId): number {
  return (
    getMusicTrackConfig(trackId).durationSeconds -
    MUSIC_LOOP_CROSSFADE_MS / 1_000
  );
}

export function getMusicTrackRequestUrl(trackId: MusicTrackId): string {
  const track = getMusicTrackConfig(trackId);
  const url = new URL(track.url, window.location.href);
  url.searchParams.set("music-cache", MUSIC_ASSET_VERSION);
  return url.href;
}
