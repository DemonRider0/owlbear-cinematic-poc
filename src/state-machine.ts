export const CLIENT_PHASES = [
  "LOADING",
  "READY",
  "ARMED",
  "FADING_IN",
  "PLAYING",
  "FADING_OUT",
  "IDLE",
  "ERROR",
] as const;

export type ClientPhase = (typeof CLIENT_PHASES)[number];

const transitions: Readonly<Record<ClientPhase, readonly ClientPhase[]>> = {
  LOADING: ["READY", "ERROR"],
  READY: ["ARMED", "LOADING", "ERROR"],
  ARMED: ["FADING_IN", "ERROR"],
  FADING_IN: ["PLAYING", "FADING_OUT", "ERROR"],
  PLAYING: ["FADING_OUT", "ERROR"],
  FADING_OUT: ["IDLE", "ERROR"],
  IDLE: ["ARMED", "LOADING", "ERROR"],
  ERROR: ["LOADING"],
};

export function isClientPhase(value: unknown): value is ClientPhase {
  return typeof value === "string" && CLIENT_PHASES.some((phase) => phase === value);
}

export function canTransition(from: ClientPhase, to: ClientPhase): boolean {
  return transitions[from].includes(to);
}

export function transition(from: ClientPhase, to: ClientPhase): ClientPhase {
  if (!canTransition(from, to)) {
    throw new Error(`Transição inválida de estado do cliente: ${from} -> ${to}`);
  }

  return to;
}

export function isReadyForPlayback(phase: ClientPhase): boolean {
  return phase === "READY" || phase === "IDLE";
}
