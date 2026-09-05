import {
  CINEMATIC_MUSIC_SYNC,
  DEFAULT_MUSIC_TRACK_ID,
  MUSIC_TRACK_CROSSFADE_MS,
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
  videoEndsAtGm: number;
  fadeInMs: number;
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
  const duration = getMusicTrackConfig(trackId).durationSeconds;
  const remainder = positionSeconds % duration;
  return remainder < 0 ? remainder + duration : remainder;
}

export function musicPositionAtGm(
  state: MusicState,
  gmTime: number,
): number {
  const elapsedSeconds = state.playing
    ? Math.max(0, gmTime - state.anchorAtGm) / 1_000
    : 0;
  return normalizeMusicPosition(
    state.trackId,
    state.positionSeconds + elapsedSeconds,
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
        CINEMATIC_MUSIC_SYNC.embeddedMusicEndsAtVideoSeconds * 1_000,
      videoEndsAtGm:
        videoStartAtGm + CINEMATIC_MUSIC_SYNC.videoDurationSeconds * 1_000,
      fadeInMs: CINEMATIC_MUSIC_SYNC.fadeInMs,
    },
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
  return (
    isRecord(value) &&
    isFiniteNumber(value.videoStartAtGm) &&
    isFiniteNumber(value.audibleAtGm) &&
    value.audibleAtGm >= value.videoStartAtGm &&
    isFiniteNumber(value.videoEndsAtGm) &&
    value.videoEndsAtGm >= value.audibleAtGm &&
    isFiniteNumber(value.fadeInMs) &&
    value.fadeInMs > 0
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
