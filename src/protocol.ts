import { PROTOCOL_VERSION } from "./config";
import {
  isMusicControlAction,
  isMusicState,
  type MusicControlAction,
  type MusicState,
} from "./music-state";
import { isClientPhase, type ClientPhase } from "./state-machine";

export interface MediaDiagnostics {
  bytes?: number;
  cacheSource?: "CACHE_STORAGE" | "NETWORK";
  contentType?: string;
  durationSeconds?: number;
  preloadMs?: number;
  readyState?: number;
  bufferedEndSeconds?: number;
}

export interface ClockDiagnostics {
  gmConnectionId: string;
  offsetGmMinusLocalMs: number;
  roundTripMs: number;
  samples: number;
}

export interface PlaybackDiagnostics {
  scheduledLocalAt?: number;
  playCalledAt?: number;
  playResolvedAt?: number;
  playingEventAt?: number;
  playCallLatenessMs?: number;
  waitingEvents?: number;
  endedAt?: number;
}

export interface ClientDiagnostics {
  clock?: ClockDiagnostics;
  error?: {
    stage: "PRELOAD" | "MODAL_PREPARE" | "PLAY" | "PLAYBACK" | "MODAL_CLOSE";
    name: string;
    message: string;
  };
  media?: MediaDiagnostics;
  playback?: PlaybackDiagnostics;
  userAgent?: string;
}

interface ProtocolBase {
  version: typeof PROTOCOL_VERSION;
  kind: string;
}

export interface HelloMessage extends ProtocolBase {
  kind: "HELLO";
  requestId: string;
  issuedAt: number;
}

export interface ClientStatusMessage extends ProtocolBase {
  kind: "CLIENT_STATUS";
  phase: ClientPhase;
  source: "BACKGROUND" | "MODAL";
  requestId?: string;
  reportedAt: number;
  diagnostics: ClientDiagnostics;
}

export interface PlayMessage extends ProtocolBase {
  kind: "PLAY";
  requestId: string;
  issuedAt: number;
  startAtGm: number;
  musicState: MusicState;
}

export interface MusicControlMessage extends ProtocolBase {
  kind: "MUSIC_CONTROL";
  requestId: string;
  issuedAt: number;
  action: MusicControlAction;
}

export interface MusicStateMessage extends ProtocolBase {
  kind: "MUSIC_STATE";
  requestId?: string;
  targetConnectionId?: string;
  issuedAt: number;
  state: MusicState;
}

export interface MusicStateRequestMessage extends ProtocolBase {
  kind: "MUSIC_STATE_REQUEST";
  requestId: string;
  issuedAt: number;
}

export interface ClockPingMessage extends ProtocolBase {
  kind: "CLOCK_PING";
  nonce: string;
  targetConnectionId: string;
  clientSentAt: number;
}

export interface ClockPongMessage extends ProtocolBase {
  kind: "CLOCK_PONG";
  nonce: string;
  targetConnectionId: string;
  clientSentAt: number;
  gmTime: number;
}

export type ProtocolMessage =
  | HelloMessage
  | ClientStatusMessage
  | PlayMessage
  | MusicControlMessage
  | MusicStateMessage
  | MusicStateRequestMessage
  | ClockPingMessage
  | ClockPongMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isProtocolMessage(value: unknown): value is ProtocolMessage {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) {
    return false;
  }

  switch (value.kind) {
    case "HELLO":
      return isNonEmptyString(value.requestId) && isFiniteNumber(value.issuedAt);
    case "CLIENT_STATUS":
      return (
        isClientPhase(value.phase) &&
        (value.source === "BACKGROUND" || value.source === "MODAL") &&
        isFiniteNumber(value.reportedAt) &&
        isRecord(value.diagnostics) &&
        (value.requestId === undefined || isNonEmptyString(value.requestId))
      );
    case "PLAY":
      return (
        isNonEmptyString(value.requestId) &&
        isFiniteNumber(value.issuedAt) &&
        isFiniteNumber(value.startAtGm) &&
        value.startAtGm >= value.issuedAt &&
        isMusicState(value.musicState) &&
        value.musicState.mode === "CINEMATIC" &&
        value.musicState.stateId === value.requestId &&
        value.musicState.updatedAtGm === value.issuedAt &&
        value.musicState.anchorAtGm === value.startAtGm
      );
    case "MUSIC_CONTROL":
      return (
        isNonEmptyString(value.requestId) &&
        isFiniteNumber(value.issuedAt) &&
        isMusicControlAction(value.action)
      );
    case "MUSIC_STATE":
      return (
        isFiniteNumber(value.issuedAt) &&
        isMusicState(value.state) &&
        (value.requestId === undefined || isNonEmptyString(value.requestId)) &&
        (value.targetConnectionId === undefined ||
          isNonEmptyString(value.targetConnectionId))
      );
    case "MUSIC_STATE_REQUEST":
      return isNonEmptyString(value.requestId) && isFiniteNumber(value.issuedAt);
    case "CLOCK_PING":
      return (
        isNonEmptyString(value.nonce) &&
        isNonEmptyString(value.targetConnectionId) &&
        isFiniteNumber(value.clientSentAt)
      );
    case "CLOCK_PONG":
      return (
        isNonEmptyString(value.nonce) &&
        isNonEmptyString(value.targetConnectionId) &&
        isFiniteNumber(value.clientSentAt) &&
        isFiniteNumber(value.gmTime)
      );
    default:
      return false;
  }
}

export function protocolMessage<T extends ProtocolMessage>(
  message: Omit<T, "version">,
): T {
  return { version: PROTOCOL_VERSION, ...message } as T;
}
