export const EXTENSION_ID = "demonrider.cinematic-sync";

// Relative to each built HTML entry so local development and a GitHub Pages
// project subpath resolve to the same asset.
export const CINEMATIC_URL = "./assets/cinematic.mp4";
export const CINEMATIC_CACHE_VERSION = "v2";
export const CINEMATIC_CACHE_PREFIX = `${EXTENSION_ID}/media/`;
export const CINEMATIC_CACHE_NAME =
  `${CINEMATIC_CACHE_PREFIX}${CINEMATIC_CACHE_VERSION}`;

export type MusicTrackId =
  | "o-porao"
  | "o-idolo"
  | "vali-et-ensomt-minne"
  | "tensao-pressagio"
  | "tensao-crescente"
  | "tensao-ruptura"
  | "perseguicao-frenetica"
  | "nightfire-ritual"
  | "what-remains"
  | "wildfire";

interface MusicLoopConfig {
  startSeconds: number;
  endSeconds: number;
  crossfadeSeconds: number;
}

export interface MusicTrackConfig {
  id: MusicTrackId;
  label: string;
  url: string;
  assetVersion?: string;
  // Duração decodificada do asset final. O ciclo runtime é calculado
  // separadamente e não reutiliza o crossfade já incorporado ao arquivo.
  durationSeconds: number;
  loopPreparation?: {
    sourceDurationSeconds: number;
    seamCrossfadeSeconds: number;
  };
  loop?: MusicLoopConfig;
  // Limite linear do pico medido no OGG, usado para reservar margem na soma.
  peak?: number;
}

export type EmfId = "emf-1" | "emf-2" | "emf-3";

export interface EmfConfig {
  id: EmfId;
  label: string;
  url: string;
  durationSeconds: number;
}

export const MUSIC_TRACKS: readonly MusicTrackConfig[] = [
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
  {
    id: "vali-et-ensomt-minne",
    label: "Vàli · Et Ensomt Minne",
    url: "./assets/music/vali-et-ensomt-minne.ogg",
    durationSeconds: 235.460,
    peak: 0.82,
    loop: { startSeconds: 195.800, endSeconds: 235.460, crossfadeSeconds: 0.460 },
  },
  {
    id: "tensao-pressagio",
    label: "Tensão — Presságio",
    url: "./assets/music/tensao-pressagio.ogg",
    assetVersion: "v2",
    durationSeconds: 63.370,
    peak: 0.79,
    loop: { startSeconds: 34.230, endSeconds: 63.370, crossfadeSeconds: 0.220 },
  },
  {
    id: "tensao-crescente",
    label: "Tensão — Crescente",
    url: "./assets/music/tensao-crescente.ogg",
    durationSeconds: 70.720,
    peak: 0.79,
    loop: { startSeconds: 47.350, endSeconds: 70.720, crossfadeSeconds: 0.240 },
  },
  {
    id: "tensao-ruptura",
    label: "Tensão — Ruptura",
    url: "./assets/music/tensao-ruptura.ogg",
    assetVersion: "v2",
    durationSeconds: 30.640,
    peak: 0.77,
    loop: { startSeconds: 23.860, endSeconds: 29.840, crossfadeSeconds: 0.200 },
  },
  {
    id: "perseguicao-frenetica",
    label: "Perseguição — Frenética",
    url: "./assets/music/perseguicao-frenetica.ogg",
    assetVersion: "v5",
    durationSeconds: 14.580,
    peak: 0.70,
    loop: { startSeconds: 5.870, endSeconds: 13.580, crossfadeSeconds: 0.140 },
  },
  {
    id: "nightfire-ritual",
    label: "Nightfire Ritual",
    url: "./assets/music/nightfire-ritual.ogg",
    assetVersion: "v2",
    durationSeconds: 177.970,
    peak: 0.86,
    loop: { startSeconds: 59.290, endSeconds: 177.970, crossfadeSeconds: 0.280 },
  },
  {
    id: "wildfire",
    label: "Wildfire",
    url: "./assets/music/wildfire.ogg",
    durationSeconds: 234.780,
    peak: 0.83,
    loop: { startSeconds: 115.600, endSeconds: 234.780, crossfadeSeconds: 0.260 },
  },
  {
    id: "what-remains",
    label: "What Remains",
    url: "./assets/music/what-remains.ogg",
    durationSeconds: 43.640,
    peak: 0.68,
    loop: { startSeconds: 15.280, endSeconds: 43.640, crossfadeSeconds: 0.480 },
  },
];

export const DEFAULT_MUSIC_TRACK_ID: MusicTrackId = "o-porao";
export const MUSIC_ASSET_VERSION = "v1";
export const EMF_ASSET_VERSION = "v1";
export const MUSIC_ROOM_METADATA_KEY = `${EXTENSION_ID}/music-state`;

export const EMFS = [
  {
    id: "emf-1",
    label: "EMF 1",
    url: "./assets/emf/emf-1.ogg",
    durationSeconds: 9.473741,
  },
  {
    id: "emf-2",
    label: "EMF 2",
    url: "./assets/emf/emf-2.ogg",
    durationSeconds: 11.702857,
  },
  {
    id: "emf-3",
    label: "EMF 3",
    url: "./assets/emf/emf-3.ogg",
    durationSeconds: 9.068005,
  },
] as const satisfies readonly EmfConfig[];

export const MUSIC_COMMAND_DELAY_MS = 500;
export const MUSIC_TRACK_CROSSFADE_MS = 4_000;
export const MUSIC_LAYER_FADE_MS = 350;
export const MUSIC_PAUSE_FADE_MS = 4_000;
export const MUSIC_MIX_RAMP_MS = 200;
export const MUSIC_LOOP_CROSSFADE_MS = 300;
export const MUSIC_CINEMATIC_FADE_OUT_MS = 500;
export const MUSIC_CINEMATIC_FADE_IN_MS = 700;
export const MUSIC_CINEMATIC_DIRECT_FADE_IN_MS = 960.335912;
export const MUSIC_CINEMATIC_POST_FADE_IN_MS = 4_000;
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
  positionSeconds: 30,
  startsAtVideoSeconds: 32.875604167,
  durationMs: MUSIC_CINEMATIC_DIRECT_FADE_IN_MS,
  targetGain: 0.251188643,
  terminalGainRampMs: 500,
  closingGain: 0.281838293,
  normalizationMs: MUSIC_CINEMATIC_POST_FADE_IN_MS,
  sourceTrackPositionAtStartSeconds: 10.6953125,
} as const satisfies {
  trackId: MusicTrackId;
  positionSeconds: number;
  startsAtVideoSeconds: number;
  durationMs: number;
  targetGain: number;
  terminalGainRampMs: number;
  closingGain: number;
  normalizationMs: number;
  sourceTrackPositionAtStartSeconds: number;
};

export const CINEMATIC_OUTRO_CANDIDATES = [
  {
    positionSeconds: 30,
    score: 0.233913,
    rmsDbfs: -9.9214,
    transientDb: 0.3672,
    spectralDistance: 0.736004,
    chromaSimilarity: 0.810344,
    rhythmSimilarity: 0.64375,
  },
  {
    positionSeconds: 63.5,
    score: 0.273377,
    rmsDbfs: -9.573,
    transientDb: 0.4509,
    spectralDistance: 0.830935,
    chromaSimilarity: 0.71928,
    rhythmSimilarity: 0.588538,
  },
  {
    positionSeconds: 254.5,
    score: 0.284293,
    rmsDbfs: -11.2997,
    transientDb: -0.0441,
    spectralDistance: 0.737772,
    chromaSimilarity: 0.855554,
    rhythmSimilarity: 0.370871,
  },
] as const;

export const PROTOCOL_VERSION = 2;
export const BROADCAST_CHANNEL = `${EXTENSION_ID}/protocol/v${PROTOCOL_VERSION}`;
export const AUDIO_ACTIVATION_CHANNEL = `${EXTENSION_ID}/audio-activation`;

export const TOOL_ID = `${EXTENSION_ID}/tool`;
export const CONTROL_POPOVER_ID = `${EXTENSION_ID}/controls`;
export const AUDIO_ACTIVATION_POPOVER_ID = `${EXTENSION_ID}/audio-activation`;
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

export function getMusicLoop(trackId: MusicTrackId) {
  const config = getMusicTrackConfig(trackId);
  const loop = config.loop ?? {
    startSeconds: 0,
    endSeconds: config.durationSeconds,
    crossfadeSeconds: MUSIC_LOOP_CROSSFADE_MS / 1_000,
  };
  const seamSeconds = loop.endSeconds - loop.crossfadeSeconds;
  return { ...loop, seamSeconds, cycleSeconds: seamSeconds - loop.startSeconds };
}

export function getMusicLoopCycleSeconds(trackId: MusicTrackId): number {
  return getMusicLoop(trackId).cycleSeconds;
}

export function getMusicTrackRequestUrl(trackId: MusicTrackId): string {
  const track = getMusicTrackConfig(trackId);
  const url = new URL(track.url, window.location.href);
  url.searchParams.set("music-cache", track.assetVersion ?? MUSIC_ASSET_VERSION);
  return url.href;
}

export function getEmfConfig(emfId: EmfId): EmfConfig {
  const emf = EMFS.find((candidate) => candidate.id === emfId);
  if (!emf) {
    throw new Error(`EMF desconhecido: ${emfId}`);
  }
  return emf;
}

export function getEmfRequestUrl(emfId: EmfId): string {
  const emf = getEmfConfig(emfId);
  const url = new URL(emf.url, window.location.href);
  url.searchParams.set("emf-cache", EMF_ASSET_VERSION);
  return url.href;
}
