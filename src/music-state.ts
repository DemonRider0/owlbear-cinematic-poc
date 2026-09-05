import {
  CINEMATIC_OUTRO_MUSIC,
  CINEMATIC_MUSIC_SYNC,
  DEFAULT_MUSIC_TRACK_ID,
  MUSIC_TRACK_CROSSFADE_MS,
  getMusicLoopCycleSeconds,
  getMusicTrackConfig,
  type MusicTrackId,
} from "./config";

export const MUSIC_STATE_SCHEMA_VERSION = 1;

export type MusicMode = "MANUAL" | "CINEMATIC";

export interface MusicTransition {
  kind: "TRACK_CROSSFADE";
  fromTrackId: MusicTrackId;
  fromPositionSeconds: number;
  startAtGm: number;
  durationMs: number;
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
  fromPositionSeconds: number;
}

export interface MusicState {
  schemaVersion: typeof MUSIC_STATE_SCHEMA_VERSION;
  stateId: string;
  revision: number;
  authorityConnectionId: string;
  updatedAtGm: number;
  mode: MusicMode;
  trackId: MusicTrackId;
  playing: boolean;
  positionSeconds: number;
  anchorAtGm: number;
  transition?: MusicTransition;
  cinematic?: CinematicMusicHandoff;
}

export type MusicControlAction =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; positionSeconds: number }
  | { type: "SELECT_TRACK"; trackId: MusicTrackId };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isMusicTrackId(value: unknown): value is MusicTrackId {
  return value === "o-porao" || value === "o-idolo";
}

export function normalizeMusicPosition(
  trackId: MusicTrackId,
  positionSeconds: number,
): number {
  const cycleSeconds = getMusicLoopCycleSeconds(trackId);
  const remainder = positionSeconds % cycleSeconds;
  return remainder < 0 ? remainder + cycleSeconds : remainder;
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
  const cycleSeconds = getMusicLoopCycleSeconds(trackId);
  const normalized = normalizeMusicPosition(trackId, positionSeconds);
  const secondsUntilSeam =
    normalized === 0 ? cycleSeconds : cycleSeconds - normalized;
  return positionAtGm + secondsUntilSeam * 1_000;
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
  action: MusicControlAction,
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

export function createCinematicMusicState(
  authorityConnectionId: string,
  stateId: string,
  revision: number,
  issuedAtGm: number,
  videoStartAtGm: number,
): MusicState {
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
      videoEndsAtGm:
        videoStartAtGm + CINEMATIC_MUSIC_SYNC.videoDurationSeconds * 1_000,
      fadeInMs: CINEMATIC_MUSIC_SYNC.fadeInMs,
      embeddedTrackGain: CINEMATIC_MUSIC_SYNC.embeddedTrackGain,
      outro: {
        trackId: CINEMATIC_OUTRO_MUSIC.trackId,
        positionSeconds: CINEMATIC_OUTRO_MUSIC.positionSeconds,
        startAtGm:
          videoStartAtGm +
          CINEMATIC_OUTRO_MUSIC.startsAtVideoSeconds * 1_000,
        durationMs: CINEMATIC_OUTRO_MUSIC.durationMs,
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
    };
  }

  const clockDeltaMs = newAuthorityNowGm - previousAuthorityNowGm;
  return {
    ...current,
    stateId,
    revision: nextRevision,
    authorityConnectionId,
    updatedAtGm,
    anchorAtGm: current.anchorAtGm + clockDeltaMs,
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
      return isMusicTrackId(value.trackId);
    default:
      return false;
  }
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
  return (
    isRecord(value) &&
    isMusicTrackId(value.trackId) &&
    isFiniteNumber(value.positionSeconds) &&
    value.positionSeconds >= 0 &&
    isFiniteNumber(value.startAtGm) &&
    isFiniteNumber(value.durationMs) &&
    value.durationMs > 0 &&
    isFiniteNumber(value.fromPositionSeconds) &&
    value.fromPositionSeconds >= 0
  );
}

export function isMusicState(value: unknown): value is MusicState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== MUSIC_STATE_SCHEMA_VERSION ||
    !isNonEmptyString(value.stateId) ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !isNonEmptyString(value.authorityConnectionId) ||
    !isFiniteNumber(value.updatedAtGm) ||
    (value.mode !== "MANUAL" && value.mode !== "CINEMATIC") ||
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
  if (value.cinematic !== undefined && !isCinematicMusicHandoff(value.cinematic)) {
    return false;
  }
  return (
    (value.mode === "MANUAL" && value.cinematic === undefined) ||
    (value.mode === "CINEMATIC" && value.playing && value.cinematic !== undefined)
  );
}
