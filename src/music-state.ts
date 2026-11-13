import {
  CINEMATIC_OUTRO_MUSIC,
  CINEMATIC_MUSIC_SYNC,
  DEFAULT_MUSIC_TRACK_ID,
  MUSIC_LAYER_FADE_MS,
  MUSIC_MIX_RAMP_MS,
  MUSIC_PAUSE_FADE_MS,
  MUSIC_TRACKS,
  MUSIC_TRACK_CROSSFADE_MS,
  getEmfConfig,
  getMusicLoop,
  getMusicTrackConfig,
  type EmfId,
  type MusicTrackId,
} from "./config";

export const MUSIC_STATE_SCHEMA_VERSION = 1;
const LAYERED_MUSIC_SCHEMA_VERSION = 2;

export type MusicMode = "MANUAL" | "CINEMATIC" | "EMF";

export interface MusicTransition {
  kind: "TRACK_CROSSFADE";
  fromTrackId: MusicTrackId;
  fromPositionSeconds: number;
  startAtGm: number;
  durationMs: number;
}

export interface MusicGainTransition {
  startAtGm: number;
  endAtGm: number;
  fromGain: number;
  toGain: number;
}

export interface CinematicMusicHandoff {
  videoStartAtGm: number;
  audibleAtGm: number;
  dominantAtGm?: number;
  embeddedMusicEndsAtGm?: number;
  normalizedAtGm?: number;
  videoEndsAtGm: number;
  fadeInMs: number;
  embeddedTrackGain?: number;
  outro?: CinematicMusicOutro;
}

export interface CinematicMusicOutro {
  trackId: MusicTrackId;
  positionSeconds: number;
  startAtGm: number;
  durationMs: number;
  targetGain?: number;
  normalizationMs?: number;
  fromPositionSeconds: number;
}

export interface EmfPlayback {
  id: EmfId;
  startAtGm: number;
  durationSeconds: number;
}

export type MusicLayerStatus = "PLAYING" | "PAUSING" | "PAUSED" | "STOPPED" | "STOPPING";
export type MusicMixVolumes = Partial<Record<MusicTrackId, number>>;

export interface MusicLayer {
  trackId: MusicTrackId;
  status: MusicLayerStatus;
  // Unwrapped transport position. This preserves whether the intro has
  // already played and lets late clients reconstruct an in-progress seam.
  positionSeconds: number;
  anchorAtGm: number;
  fade?: MusicGainTransition;
  mixTransition?: MusicGainTransition;
  waitingForTrackId?: MusicTrackId;
}

export interface MusicState {
  schemaVersion: typeof MUSIC_STATE_SCHEMA_VERSION | typeof LAYERED_MUSIC_SCHEMA_VERSION;
  stateId: string;
  revision: number;
  authorityConnectionId: string;
  updatedAtGm: number;
  mode: MusicMode;
  trackId: MusicTrackId;
  playing: boolean;
  positionSeconds: number;
  anchorAtGm: number;
  gainTransition?: MusicGainTransition;
  transition?: MusicTransition;
  cinematic?: CinematicMusicHandoff;
  emf?: EmfPlayback;
  layers?: MusicLayer[];
  mixVolumes?: MusicMixVolumes;
}

export type ManualMusicControlAction =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; positionSeconds: number }
  | { type: "SELECT_TRACK"; trackId: MusicTrackId };

export type MusicControlAction =
  | ManualMusicControlAction
  | LayerMusicControlAction
  | { type: "PLAY_EMF"; emfId: EmfId };

export type LayerMusicControlAction =
  | { type: "ADD_TRACK" | "REPLACE_TRACK" | "PLAY_LAYER" | "PAUSE_LAYER" | "STOP_LAYER"; trackId: MusicTrackId }
  | { type: "SEEK_LAYER"; trackId: MusicTrackId; positionSeconds: number }
  | { type: "SET_MIX_VOLUME"; trackId: MusicTrackId; volume: number };

export function isLayerMusicControlAction(action: MusicControlAction): action is LayerMusicControlAction {
  return "trackId" in action && action.type !== "SELECT_TRACK";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function stripLegacyVolumeFields(state: MusicState): MusicState {
  const sanitized = { ...state } as MusicState & {
    musicVolume?: unknown;
    effectsVolume?: unknown;
  };
  delete sanitized.musicVolume;
  delete sanitized.effectsVolume;
  return sanitized;
}

export function isMusicTrackId(value: unknown): value is MusicTrackId {
  return MUSIC_TRACKS.some(({ id }) => id === value);
}

export function isEmfId(value: unknown): value is EmfId {
  return value === "emf-1" || value === "emf-2" || value === "emf-3";
}

export function normalizeMusicPosition(
  trackId: MusicTrackId,
  positionSeconds: number,
): number {
  const { startSeconds, seamSeconds, cycleSeconds } = getMusicLoop(trackId);
  if (positionSeconds >= 0 && positionSeconds < seamSeconds) {
    return positionSeconds;
  }
  const remainder = (positionSeconds - seamSeconds) % cycleSeconds;
  return startSeconds + (remainder < 0 ? remainder + cycleSeconds : remainder);
}

export function normalizeMusicMediaPosition(
  trackId: MusicTrackId,
  positionSeconds: number,
): number {
  const duration = getMusicTrackConfig(trackId).durationSeconds;
  const remainder = positionSeconds % duration;
  return remainder < 0 ? remainder + duration : remainder;
}

export function nextMusicLoopSeamAtGm(
  trackId: MusicTrackId,
  positionSeconds: number,
  positionAtGm: number,
): number {
  const { seamSeconds } = getMusicLoop(trackId);
  const normalized = normalizeMusicPosition(trackId, positionSeconds);
  return positionAtGm + (seamSeconds - normalized) * 1_000;
}

export function musicPositionAtGm(
  state: MusicState,
  gmTime: number,
): number {
  const elapsedSeconds = state.playing
    ? Math.max(0, gmTime - state.anchorAtGm) / 1_000
    : 0;
  const position = state.positionSeconds + elapsedSeconds;
  return state.mode === "CINEMATIC"
    ? normalizeMusicMediaPosition(state.trackId, position)
    : normalizeMusicPosition(state.trackId, position);
}

export function musicGainAtGm(state: MusicState, gmTime: number): number {
  return gainAtGm(state.gainTransition, gmTime, getMusicMixVolume(state, state.trackId));
}

function gainAtGm(
  transition: MusicGainTransition | undefined,
  gmTime: number,
  fallback: number,
  equalPower = false,
): number {
  if (!transition || gmTime >= transition.endAtGm) {
    return transition?.toGain ?? fallback;
  }
  if (gmTime <= transition.startAtGm) {
    return transition.fromGain;
  }
  const progress =
    (gmTime - transition.startAtGm) /
    (transition.endAtGm - transition.startAtGm);
  const smoothProgress = equalPower
    ? transition.toGain >= transition.fromGain
      ? Math.sin(progress * Math.PI / 2)
      : 1 - Math.cos(progress * Math.PI / 2)
    : progress * progress * (3 - 2 * progress);
  return (
    transition.fromGain +
    (transition.toGain - transition.fromGain) * smoothProgress
  );
}

export function getMusicMixVolume(state: MusicState, trackId: MusicTrackId): number {
  return state.mixVolumes?.[trackId] ?? 1;
}

export function musicLayerStatusAtGm(layer: MusicLayer, gmTime: number): MusicLayerStatus {
  if (layer.fade && gmTime >= layer.fade.endAtGm) {
    if (layer.status === "PAUSING") return "PAUSED";
    if (layer.status === "STOPPING") return "STOPPED";
  }
  return layer.status;
}

export function musicLayerIsPlaying(layer: MusicLayer, gmTime: number): boolean {
  const status = musicLayerStatusAtGm(layer, gmTime);
  return status === "PLAYING" || status === "STOPPING" || status === "PAUSING";
}

function musicLayerTransportPosition(layer: MusicLayer, gmTime: number): number {
  if (musicLayerStatusAtGm(layer, gmTime) === "STOPPED") {
    return 0;
  }
  // PAUSING keeps its original timeline, even in a persisted snapshot
  // read long after the fade completed.
  const positionAtGm = layer.status === "PAUSING" && layer.fade
    ? Math.min(gmTime, layer.fade.endAtGm)
    : gmTime;
  return layer.positionSeconds + (musicLayerIsPlaying(layer, positionAtGm) || layer.status === "PAUSING"
    ? Math.max(0, positionAtGm - layer.anchorAtGm) / 1_000
    : 0);
}

export function musicLayerPositionAtGm(layer: MusicLayer, gmTime: number): number {
  return normalizeMusicPosition(layer.trackId, musicLayerTransportPosition(layer, gmTime));
}

export function musicLayerMixAtGm(state: MusicState, layer: MusicLayer, gmTime: number): number {
  return gainAtGm(layer.mixTransition, gmTime, getMusicMixVolume(state, layer.trackId));
}

export function musicLayerFadeAtGm(layer: MusicLayer, gmTime: number): number {
  return gainAtGm(layer.fade, gmTime, 1, true);
}

function transitionGain(
  startAtGm: number,
  durationMs: number,
  fromGain: number,
  toGain: number,
): MusicGainTransition {
  return { startAtGm, endAtGm: startAtGm + durationMs, fromGain, toGain };
}

export function getMusicLayer(state: MusicState, trackId: MusicTrackId): MusicLayer | undefined {
  if (state.mode === "CINEMATIC") {
    return undefined;
  }
  if (state.layers) {
    return state.layers.find((layer) => layer.trackId === trackId);
  }
  const transition = state.transition;
  if (transition?.fromTrackId === trackId && state.playing) {
    return {
      trackId,
      status: "STOPPING",
      positionSeconds: transition.fromPositionSeconds,
      anchorAtGm: transition.startAtGm,
      fade: transitionGain(transition.startAtGm, transition.durationMs, 1, 0),
    };
  }
  if (state.trackId !== trackId) {
    return undefined;
  }
  return {
    trackId,
    status: state.playing ? "PLAYING" : state.revision === 0 ? "STOPPED" : "PAUSED",
    positionSeconds: state.positionSeconds,
    anchorAtGm: state.anchorAtGm,
    fade: transition
      ? transitionGain(transition.startAtGm, transition.durationMs, 0, 1)
      : undefined,
    mixTransition: state.gainTransition,
  };
}

function pauseLayer(layer: MusicLayer, applyAtGm: number): MusicLayer {
  return {
    ...layer,
    status: "PAUSED",
    positionSeconds: musicLayerTransportPosition(layer, applyAtGm),
    anchorAtGm: applyAtGm,
    fade: undefined,
    waitingForTrackId: undefined,
  };
}

function stopLayer(
  layer: MusicLayer, applyAtGm: number, fadeMs: number, waitingForTrackId?: MusicTrackId,
): MusicLayer {
  const status = musicLayerStatusAtGm(layer, applyAtGm);
  if (status === "STOPPING" || status === "STOPPED") {
    return layer;
  }
  const gain = musicLayerFadeAtGm(layer, applyAtGm);
  if ((status === "PLAYING" || status === "PAUSING") && gain > 0) {
    return {
      ...layer,
      status: "STOPPING",
      fade: transitionGain(applyAtGm, fadeMs, gain, 0),
      waitingForTrackId,
    };
  }
  return {
    ...layer,
    status: "STOPPED",
    positionSeconds: 0,
    anchorAtGm: applyAtGm,
    fade: undefined,
    waitingForTrackId: undefined,
  };
}

function startLayer(
  layer: MusicLayer,
  applyAtGm: number,
  durationMs: number,
  replace: boolean,
): MusicLayer {
  const status = musicLayerStatusAtGm(layer, applyAtGm);
  if (status === "PLAYING") {
    return layer;
  }
  const keepTimeline = status === "STOPPING" || status === "PAUSING";
  return {
    ...layer,
    status: "PLAYING",
    positionSeconds: keepTimeline ? layer.positionSeconds
      : replace ? 0 : musicLayerTransportPosition(layer, applyAtGm),
    anchorAtGm: keepTimeline ? layer.anchorAtGm : applyAtGm,
    waitingForTrackId: undefined,
    fade: transitionGain(
      applyAtGm,
      durationMs,
      keepTimeline ? musicLayerFadeAtGm(layer, applyAtGm) : 0,
      1,
    ),
  };
}

export function createLayeredMusicState(
  current: MusicState,
  action: LayerMusicControlAction,
  authorityConnectionId: string,
  stateId: string,
  issuedAtGm: number,
  applyAtGm: number,
): MusicState {
  const trackId = action.trackId;
  const currentLayer = getMusicLayer(current, trackId);
  const layer: MusicLayer = currentLayer ?? {
    trackId,
    status: "STOPPED",
    positionSeconds: 0,
    anchorAtGm: applyAtGm,
  };
  let next = layer;
  let mixVolumes = current.mixVolumes;
  const previousOtherLayers = MUSIC_TRACKS
    .filter(({ id }) => id !== trackId)
    .map(({ id }) => getMusicLayer(current, id))
    .filter((entry): entry is MusicLayer => entry !== undefined);
  let otherLayers = previousOtherLayers;
  const status = musicLayerStatusAtGm(layer, applyAtGm);
  switch (action.type) {
    case "ADD_TRACK":
      next = startLayer(layer, applyAtGm, MUSIC_LAYER_FADE_MS, false);
      break;
    case "PLAY_LAYER":
      next = startLayer(
        layer,
        applyAtGm,
        status === "PAUSED" || status === "PAUSING" ? MUSIC_PAUSE_FADE_MS : MUSIC_LAYER_FADE_MS,
        false,
      );
      break;
    case "REPLACE_TRACK":
      next = startLayer(layer, applyAtGm, MUSIC_TRACK_CROSSFADE_MS, true);
      otherLayers = otherLayers.map((entry) =>
        stopLayer(entry, applyAtGm, MUSIC_TRACK_CROSSFADE_MS, next !== layer ? trackId : undefined),
      );
      break;
    case "PAUSE_LAYER":
      if (status === "PLAYING" || status === "STOPPING") {
        next = {
          ...layer,
          status: "PAUSING",
          fade: transitionGain(applyAtGm, MUSIC_PAUSE_FADE_MS, musicLayerFadeAtGm(layer, applyAtGm), 0),
          waitingForTrackId: undefined,
        };
      }
      break;
    case "STOP_LAYER":
      next = stopLayer(layer, applyAtGm, MUSIC_LAYER_FADE_MS);
      break;
    case "SEEK_LAYER": {
      const { seamSeconds } = getMusicLoop(trackId);
      next = {
        ...layer,
        status: status === "PLAYING" || status === "PAUSING" ? status : "PAUSED",
        positionSeconds: Math.min(action.positionSeconds, seamSeconds - 0.001),
        anchorAtGm: applyAtGm,
        fade: status === "PLAYING" || status === "PAUSING" ? layer.fade : undefined,
        waitingForTrackId: undefined,
      };
      break;
    }
    case "SET_MIX_VOLUME":
      if (getMusicMixVolume(current, trackId) !== action.volume) {
        mixVolumes = { ...mixVolumes, [trackId]: action.volume };
        next = {
          ...layer,
          mixTransition: transitionGain(
            applyAtGm,
            MUSIC_MIX_RAMP_MS,
            musicLayerMixAtGm(current, layer, applyAtGm),
            action.volume,
          ),
        };
      }
      break;
  }
  if (
    next === layer &&
    otherLayers.every((entry, index) => entry === previousOtherLayers[index])
  ) {
    return current;
  }
  const layers = [...otherLayers, next];
  // Volume edits leave an exclusive EMF playing on its original anchor.
  const keepEmf = current.mode === "EMF" &&
    action.type !== "ADD_TRACK" && action.type !== "REPLACE_TRACK" && action.type !== "PLAY_LAYER";
  return {
    schemaVersion: LAYERED_MUSIC_SCHEMA_VERSION,
    stateId,
    revision: current.revision + 1,
    authorityConnectionId,
    updatedAtGm: Math.max(issuedAtGm, current.updatedAtGm + 1),
    mode: keepEmf ? "EMF" : "MANUAL",
    trackId,
    playing: !keepEmf && layers.some((entry) => musicLayerIsPlaying(entry, applyAtGm)),
    positionSeconds: musicLayerPositionAtGm(next, applyAtGm),
    anchorAtGm: applyAtGm,
    emf: keepEmf ? current.emf : undefined,
    mixVolumes,
    layers,
  };
}

export function emfPositionAtGm(
  state: MusicState,
  gmTime: number,
): number | undefined {
  if (state.mode !== "EMF" || !state.emf) {
    return undefined;
  }
  return Math.max(0, gmTime - state.emf.startAtGm) / 1_000;
}

export function isEmfActive(state: MusicState, gmTime: number): boolean {
  const position = emfPositionAtGm(state, gmTime);
  return (
    position !== undefined &&
    gmTime >= (state.emf?.startAtGm ?? Number.POSITIVE_INFINITY) &&
    position < (state.emf?.durationSeconds ?? 0)
  );
}

export function isCinematicMusicLocked(
  state: MusicState,
  gmTime: number,
): boolean {
  return (
    state.mode === "CINEMATIC" &&
    state.cinematic !== undefined &&
    gmTime < state.cinematic.videoEndsAtGm
  );
}

export function compareMusicStates(left: MusicState, right: MusicState): number {
  if (left.authorityConnectionId === right.authorityConnectionId && left.revision !== right.revision) {
    return left.revision - right.revision;
  }
  if (left.updatedAtGm !== right.updatedAtGm) {
    return left.updatedAtGm - right.updatedAtGm;
  }
  return left.stateId.localeCompare(right.stateId);
}

export function createInitialMusicState(
  authorityConnectionId: string,
  stateId: string,
  nowGm: number,
): MusicState {
  return {
    schemaVersion: MUSIC_STATE_SCHEMA_VERSION,
    stateId,
    revision: 0,
    authorityConnectionId,
    updatedAtGm: nowGm,
    mode: "MANUAL",
    trackId: DEFAULT_MUSIC_TRACK_ID,
    playing: false,
    positionSeconds: 0,
    anchorAtGm: nowGm,
  };
}

export function createManualMusicState(
  current: MusicState,
  action: ManualMusicControlAction,
  authorityConnectionId: string,
  stateId: string,
  issuedAtGm: number,
  applyAtGm: number,
): MusicState {
  const currentPosition = musicPositionAtGm(current, applyAtGm);
  const base: MusicState = {
    schemaVersion: MUSIC_STATE_SCHEMA_VERSION,
    stateId,
    revision: current.revision + 1,
    authorityConnectionId,
    updatedAtGm: Math.max(issuedAtGm, current.updatedAtGm + 1),
    mode: "MANUAL" as const,
    trackId: current.trackId,
    playing: current.playing,
    positionSeconds: currentPosition,
    anchorAtGm: applyAtGm,
    gainTransition: current.gainTransition,
    mixVolumes: current.mixVolumes,
  };

  switch (action.type) {
    case "PLAY":
      return { ...base, playing: true };
    case "PAUSE":
      return { ...base, playing: false };
    case "SEEK":
      return {
        ...base,
        positionSeconds: normalizeMusicPosition(
          current.trackId,
          action.positionSeconds,
        ),
      };
    case "SELECT_TRACK": {
      if (action.trackId === current.trackId) {
        return base;
      }
      return {
        ...base,
        trackId: action.trackId,
        positionSeconds: 0,
        transition: current.playing
          ? {
              kind: "TRACK_CROSSFADE",
              fromTrackId: current.trackId,
              fromPositionSeconds: currentPosition,
              startAtGm: applyAtGm,
              durationMs: MUSIC_TRACK_CROSSFADE_MS,
            }
          : undefined,
      };
    }
  }
}

export function createEmfMusicState(
  current: MusicState,
  emfId: EmfId,
  authorityConnectionId: string,
  stateId: string,
  issuedAtGm: number,
  applyAtGm: number,
): MusicState {
  const layers = current.layers?.map((layer) => {
    const status = musicLayerStatusAtGm(layer, applyAtGm);
    if (status === "PLAYING" || status === "PAUSING" ||
      (status === "PAUSED" && layer.status === "PAUSING")) {
      return pauseLayer(layer, applyAtGm);
    }
    return status === "PAUSED" ? layer : {
      ...layer,
      status: "STOPPED" as const,
      positionSeconds: 0,
      fade: undefined,
      waitingForTrackId: undefined,
    };
  });
  return {
    schemaVersion: current.schemaVersion,
    stateId,
    revision: current.revision + 1,
    authorityConnectionId,
    updatedAtGm: Math.max(issuedAtGm, current.updatedAtGm + 1),
    mode: "EMF",
    trackId: current.trackId,
    playing: false,
    positionSeconds: musicPositionAtGm(current, applyAtGm),
    anchorAtGm: applyAtGm,
    mixVolumes: current.mixVolumes,
    layers,
    emf: {
      id: emfId,
      startAtGm: applyAtGm,
      durationSeconds: getEmfConfig(emfId).durationSeconds,
    },
  };
}

export function createCinematicMusicState(
  authorityConnectionId: string,
  stateId: string,
  revision: number,
  issuedAtGm: number,
  videoStartAtGm: number,
  mixVolumes?: MusicMixVolumes,
): MusicState {
  const videoEndsAtGm =
    videoStartAtGm + CINEMATIC_MUSIC_SYNC.videoDurationSeconds * 1_000;
  return {
    schemaVersion: MUSIC_STATE_SCHEMA_VERSION,
    stateId,
    revision,
    authorityConnectionId,
    updatedAtGm: issuedAtGm,
    mode: "CINEMATIC",
    trackId: CINEMATIC_MUSIC_SYNC.trackId,
    playing: true,
    positionSeconds: CINEMATIC_MUSIC_SYNC.playerPositionAtVideoStartSeconds,
    anchorAtGm: videoStartAtGm,
    mixVolumes,
    gainTransition: {
      startAtGm:
        videoEndsAtGm - CINEMATIC_OUTRO_MUSIC.terminalGainRampMs,
      endAtGm: videoEndsAtGm,
      fromGain: CINEMATIC_OUTRO_MUSIC.targetGain,
      toGain: CINEMATIC_OUTRO_MUSIC.closingGain,
    },
    cinematic: {
      videoStartAtGm,
      audibleAtGm:
        videoStartAtGm +
        CINEMATIC_MUSIC_SYNC.externalOverlapStartsAtVideoSeconds * 1_000,
      dominantAtGm:
        videoStartAtGm +
        CINEMATIC_MUSIC_SYNC.externalDominantAtVideoSeconds * 1_000,
      embeddedMusicEndsAtGm:
        videoStartAtGm +
        CINEMATIC_MUSIC_SYNC.embeddedMusicEndsAtVideoSeconds * 1_000,
      normalizedAtGm:
        videoStartAtGm +
        CINEMATIC_MUSIC_SYNC.gainNormalizationEndsAtVideoSeconds * 1_000,
      videoEndsAtGm,
      fadeInMs: CINEMATIC_MUSIC_SYNC.fadeInMs,
      embeddedTrackGain: CINEMATIC_MUSIC_SYNC.embeddedTrackGain,
      outro: {
        trackId: CINEMATIC_OUTRO_MUSIC.trackId,
        positionSeconds: CINEMATIC_OUTRO_MUSIC.positionSeconds,
        startAtGm:
          videoStartAtGm +
          CINEMATIC_OUTRO_MUSIC.startsAtVideoSeconds * 1_000,
        durationMs: CINEMATIC_OUTRO_MUSIC.durationMs,
        targetGain: CINEMATIC_OUTRO_MUSIC.targetGain,
        normalizationMs: CINEMATIC_OUTRO_MUSIC.normalizationMs,
        fromPositionSeconds:
          CINEMATIC_OUTRO_MUSIC.sourceTrackPositionAtStartSeconds,
      },
    },
  };
}

export function createPostCinematicMusicState(
  current: MusicState,
  authorityConnectionId: string,
  stateId: string,
  issuedAtGm: number,
): MusicState {
  const handoff = current.cinematic;
  const outro = handoff?.outro;
  if (current.mode !== "CINEMATIC" || !handoff || !outro) {
    throw new Error("Estado cinematic sem transição musical final.");
  }
  const closingGain = musicGainAtGm(current, handoff.videoEndsAtGm);
  const mixVolume = getMusicMixVolume(current, outro.trackId);

  return {
    schemaVersion: MUSIC_STATE_SCHEMA_VERSION,
    stateId,
    revision: current.revision + 1,
    authorityConnectionId,
    updatedAtGm: Math.max(issuedAtGm, current.updatedAtGm + 1),
    mode: "MANUAL",
    trackId: outro.trackId,
    playing: true,
    positionSeconds: normalizeMusicPosition(
      outro.trackId,
      outro.positionSeconds +
        (handoff.videoEndsAtGm - outro.startAtGm) / 1_000,
    ),
    anchorAtGm: handoff.videoEndsAtGm,
    mixVolumes: current.mixVolumes,
    gainTransition:
      closingGain !== mixVolume && (outro.normalizationMs ?? 0) > 0
        ? {
            startAtGm: handoff.videoEndsAtGm,
            endAtGm:
              handoff.videoEndsAtGm + (outro.normalizationMs ?? 0),
            fromGain: closingGain,
            toGain: mixVolume,
          }
        : undefined,
  };
}

export function createAuthorityTakeoverMusicState(
  current: MusicState,
  authorityConnectionId: string,
  stateId: string,
  previousAuthorityNowGm: number,
  newAuthorityNowGm: number,
): MusicState {
  const nextRevision = current.revision + 1;
  const updatedAtGm = Math.max(
    newAuthorityNowGm,
    current.updatedAtGm + 1,
  );
  const handoff = current.cinematic;
  const outro = handoff?.outro;

  if (
    current.mode === "CINEMATIC" &&
    handoff &&
    outro &&
    previousAuthorityNowGm >= handoff.videoEndsAtGm
  ) {
    const targetGain = musicGainAtGm(current, handoff.videoEndsAtGm);
    const mixVolume = getMusicMixVolume(current, outro.trackId);
    const normalizationMs = outro.normalizationMs ?? 0;
    const gainTransitionEndsAtGm =
      handoff.videoEndsAtGm + normalizationMs;
    const clockDeltaMs = newAuthorityNowGm - previousAuthorityNowGm;
    return {
      schemaVersion: MUSIC_STATE_SCHEMA_VERSION,
      stateId,
      revision: nextRevision,
      authorityConnectionId,
      updatedAtGm,
      mode: "MANUAL",
      trackId: outro.trackId,
      playing: true,
      positionSeconds: normalizeMusicPosition(
        outro.trackId,
        outro.positionSeconds +
          Math.max(0, previousAuthorityNowGm - outro.startAtGm) / 1_000,
      ),
      anchorAtGm: newAuthorityNowGm,
      mixVolumes: current.mixVolumes,
      gainTransition:
        targetGain !== mixVolume &&
        normalizationMs > 0 &&
        previousAuthorityNowGm < gainTransitionEndsAtGm
          ? {
              startAtGm: handoff.videoEndsAtGm + clockDeltaMs,
              endAtGm: gainTransitionEndsAtGm + clockDeltaMs,
              fromGain: targetGain,
              toGain: mixVolume,
            }
          : undefined,
    };
  }

  const clockDeltaMs = newAuthorityNowGm - previousAuthorityNowGm;
  const moveGain = (transition: MusicGainTransition | undefined) => transition
    ? {
        ...transition,
        startAtGm: transition.startAtGm + clockDeltaMs,
        endAtGm: transition.endAtGm + clockDeltaMs,
      }
    : undefined;
  return {
    ...stripLegacyVolumeFields(current),
    stateId,
    revision: nextRevision,
    authorityConnectionId,
    updatedAtGm,
    anchorAtGm: current.anchorAtGm + clockDeltaMs,
    gainTransition: moveGain(current.gainTransition),
    layers: current.layers?.map((layer) => ({
      ...layer,
      anchorAtGm: layer.anchorAtGm + clockDeltaMs,
      fade: moveGain(layer.fade),
      mixTransition: moveGain(layer.mixTransition),
    })),
    transition: current.transition
      ? {
          ...current.transition,
          startAtGm: current.transition.startAtGm + clockDeltaMs,
        }
      : undefined,
    cinematic: handoff
      ? {
          ...handoff,
          videoStartAtGm: handoff.videoStartAtGm + clockDeltaMs,
          audibleAtGm: handoff.audibleAtGm + clockDeltaMs,
          dominantAtGm:
            handoff.dominantAtGm === undefined
              ? undefined
              : handoff.dominantAtGm + clockDeltaMs,
          embeddedMusicEndsAtGm:
            handoff.embeddedMusicEndsAtGm === undefined
              ? undefined
              : handoff.embeddedMusicEndsAtGm + clockDeltaMs,
          normalizedAtGm:
            handoff.normalizedAtGm === undefined
              ? undefined
              : handoff.normalizedAtGm + clockDeltaMs,
          videoEndsAtGm: handoff.videoEndsAtGm + clockDeltaMs,
          outro: outro
            ? {
                ...outro,
                startAtGm: outro.startAtGm + clockDeltaMs,
              }
            : undefined,
        }
      : undefined,
    emf: current.emf
      ? {
          ...current.emf,
          startAtGm: current.emf.startAtGm + clockDeltaMs,
        }
      : undefined,
  };
}

export function isMusicControlAction(value: unknown): value is MusicControlAction {
  if (!isRecord(value) || !isNonEmptyString(value.type)) {
    return false;
  }
  switch (value.type) {
    case "PLAY":
    case "PAUSE":
      return true;
    case "SEEK":
      return isFiniteNumber(value.positionSeconds) && value.positionSeconds >= 0;
    case "SELECT_TRACK":
    case "ADD_TRACK":
    case "REPLACE_TRACK":
    case "PLAY_LAYER":
    case "PAUSE_LAYER":
    case "STOP_LAYER":
      return isMusicTrackId(value.trackId);
    case "SEEK_LAYER":
      return isMusicTrackId(value.trackId) &&
        isFiniteNumber(value.positionSeconds) && value.positionSeconds >= 0;
    case "SET_MIX_VOLUME":
      return isMusicTrackId(value.trackId) && isUnitGain(value.volume);
    case "PLAY_EMF":
      return isEmfId(value.emfId);
    default:
      return false;
  }
}

function isEmfPlayback(value: unknown): value is EmfPlayback {
  return (
    isRecord(value) &&
    isEmfId(value.id) &&
    isFiniteNumber(value.startAtGm) &&
    isFiniteNumber(value.durationSeconds) &&
    value.durationSeconds === getEmfConfig(value.id).durationSeconds
  );
}

function isMusicTransition(value: unknown): value is MusicTransition {
  return (
    isRecord(value) &&
    value.kind === "TRACK_CROSSFADE" &&
    isMusicTrackId(value.fromTrackId) &&
    isFiniteNumber(value.fromPositionSeconds) &&
    value.fromPositionSeconds >= 0 &&
    isFiniteNumber(value.startAtGm) &&
    isFiniteNumber(value.durationMs) &&
    value.durationMs > 0
  );
}

function isUnitGain(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isMusicGainTransition(value: unknown): value is MusicGainTransition {
  return (
    isRecord(value) &&
    isFiniteNumber(value.startAtGm) &&
    isFiniteNumber(value.endAtGm) &&
    value.endAtGm > value.startAtGm &&
    isUnitGain(value.fromGain) &&
    isUnitGain(value.toGain)
  );
}

function isCinematicMusicHandoff(value: unknown): value is CinematicMusicHandoff {
  if (!isRecord(value)) {
    return false;
  }

  const videoStartAtGm = value.videoStartAtGm;
  const audibleAtGm = value.audibleAtGm;
  const videoEndsAtGm = value.videoEndsAtGm;
  const fadeInMs = value.fadeInMs;
  if (
    !isFiniteNumber(videoStartAtGm) ||
    !isFiniteNumber(audibleAtGm) ||
    audibleAtGm < videoStartAtGm ||
    !isFiniteNumber(videoEndsAtGm) ||
    videoEndsAtGm < audibleAtGm ||
    !isFiniteNumber(fadeInMs) ||
    fadeInMs <= 0
  ) {
    return false;
  }

  const dominantAtGm = value.dominantAtGm;
  const embeddedMusicEndsAtGm = value.embeddedMusicEndsAtGm;
  const normalizedAtGm = value.normalizedAtGm;
  const embeddedTrackGain = value.embeddedTrackGain;
  if (
    (dominantAtGm !== undefined && !isFiniteNumber(dominantAtGm)) ||
    (embeddedMusicEndsAtGm !== undefined &&
      !isFiniteNumber(embeddedMusicEndsAtGm)) ||
    (normalizedAtGm !== undefined && !isFiniteNumber(normalizedAtGm)) ||
    (embeddedTrackGain !== undefined &&
      (!isFiniteNumber(embeddedTrackGain) ||
        embeddedTrackGain <= 0 ||
        embeddedTrackGain > 1))
  ) {
    return false;
  }
  if (
    (dominantAtGm !== undefined &&
      (dominantAtGm < audibleAtGm || dominantAtGm > videoEndsAtGm)) ||
    (embeddedMusicEndsAtGm !== undefined &&
      (embeddedMusicEndsAtGm < audibleAtGm ||
        embeddedMusicEndsAtGm > videoEndsAtGm)) ||
    (normalizedAtGm !== undefined &&
      (normalizedAtGm < (embeddedMusicEndsAtGm ?? audibleAtGm) ||
        normalizedAtGm > videoEndsAtGm))
  ) {
    return false;
  }
  const outro = value.outro;
  if (outro !== undefined) {
    if (!isCinematicMusicOutro(outro)) {
      return false;
    }
    if (
      outro.startAtGm < videoStartAtGm ||
      outro.startAtGm + outro.durationMs > videoEndsAtGm + 1
    ) {
      return false;
    }
  }
  return true;
}

function isCinematicMusicOutro(value: unknown): value is CinematicMusicOutro {
  const targetGain = isRecord(value) ? value.targetGain : undefined;
  const normalizationMs = isRecord(value) ? value.normalizationMs : undefined;
  return (
    isRecord(value) &&
    isMusicTrackId(value.trackId) &&
    isFiniteNumber(value.positionSeconds) &&
    value.positionSeconds >= 0 &&
    isFiniteNumber(value.startAtGm) &&
    isFiniteNumber(value.durationMs) &&
    value.durationMs > 0 &&
    (targetGain === undefined ||
      (isFiniteNumber(targetGain) && targetGain > 0 && targetGain <= 1)) &&
    (normalizationMs === undefined ||
      (isFiniteNumber(normalizationMs) && normalizationMs >= 0)) &&
    isFiniteNumber(value.fromPositionSeconds) &&
    value.fromPositionSeconds >= 0
  );
}

function isMusicLayer(value: unknown): value is MusicLayer {
  return isRecord(value) &&
    isMusicTrackId(value.trackId) &&
    (value.status === "PLAYING" || value.status === "PAUSING" || value.status === "PAUSED" ||
      value.status === "STOPPED" || value.status === "STOPPING") &&
    isFiniteNumber(value.anchorAtGm) &&
    isFiniteNumber(value.positionSeconds) && value.positionSeconds >= 0 &&
    (value.fade === undefined || isMusicGainTransition(value.fade)) &&
    ((value.status !== "STOPPING" && value.status !== "PAUSING") ||
      (isMusicGainTransition(value.fade) && value.fade.toGain === 0)) &&
    (value.waitingForTrackId === undefined ||
      (value.status === "STOPPING" && isMusicTrackId(value.waitingForTrackId) && value.trackId !== value.waitingForTrackId)) &&
    (value.mixTransition === undefined || isMusicGainTransition(value.mixTransition));
}

function isLayerSnapshot(value: Record<string, unknown>): boolean {
  if (value.mixVolumes !== undefined && (
    !isRecord(value.mixVolumes) || Array.isArray(value.mixVolumes) ||
    !Object.entries(value.mixVolumes).every(([id, gain]) => isMusicTrackId(id) && isUnitGain(gain))
  )) {
    return false;
  }
  if (value.schemaVersion === MUSIC_STATE_SCHEMA_VERSION) {
    return value.layers === undefined;
  }
  const { layers, anchorAtGm } = value;
  if (value.mode === "CINEMATIC" || value.transition !== undefined || value.gainTransition !== undefined ||
    !isFiniteNumber(anchorAtGm) || !Array.isArray(layers) || layers.length > MUSIC_TRACKS.length ||
    !layers.every(isMusicLayer)) {
    return false;
  }
  const ids = new Set(layers.map(({ trackId }) => trackId));
  return isMusicTrackId(value.trackId) && ids.has(value.trackId) && ids.size === layers.length &&
    layers.every(({ anchorAtGm: layerAnchor, waitingForTrackId }) =>
      layerAnchor <= anchorAtGm && (waitingForTrackId === undefined || ids.has(waitingForTrackId)),
    ) &&
    value.playing === layers.some((layer) => musicLayerIsPlaying(layer, anchorAtGm)) &&
    (value.mode !== "EMF" || layers.every(({ status }) => status === "PAUSED" || status === "STOPPED"));
}

export function isMusicState(value: unknown): value is MusicState {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== MUSIC_STATE_SCHEMA_VERSION && value.schemaVersion !== LAYERED_MUSIC_SCHEMA_VERSION) ||
    !isNonEmptyString(value.stateId) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !isNonEmptyString(value.authorityConnectionId) ||
    !isFiniteNumber(value.updatedAtGm) ||
    (value.mode !== "MANUAL" &&
      value.mode !== "CINEMATIC" &&
      value.mode !== "EMF") ||
    !isMusicTrackId(value.trackId) ||
    typeof value.playing !== "boolean" ||
    !isFiniteNumber(value.positionSeconds) ||
    value.positionSeconds < 0 ||
    !isFiniteNumber(value.anchorAtGm)
  ) {
    return false;
  }

  if (value.transition !== undefined && !isMusicTransition(value.transition)) {
    return false;
  }
  if (
    value.gainTransition !== undefined &&
    !isMusicGainTransition(value.gainTransition)
  ) {
    return false;
  }
  if (value.cinematic !== undefined && !isCinematicMusicHandoff(value.cinematic)) {
    return false;
  }
  if (value.emf !== undefined && !isEmfPlayback(value.emf)) {
    return false;
  }
  if (!isLayerSnapshot(value)) {
    return false;
  }
  return (
    (value.mode === "MANUAL" &&
      value.cinematic === undefined &&
      value.emf === undefined) ||
    (value.mode === "CINEMATIC" &&
      value.playing &&
      value.cinematic !== undefined &&
      value.emf === undefined) ||
    (value.mode === "EMF" &&
      !value.playing &&
      value.cinematic === undefined &&
      value.transition === undefined &&
      value.gainTransition === undefined &&
      value.emf !== undefined)
  );
}
