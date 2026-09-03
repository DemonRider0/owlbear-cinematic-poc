export interface ClockSample {
  offsetGmMinusLocalMs: number;
  roundTripMs: number;
}

export function calculateClockSample(
  clientSentAt: number,
  clientReceivedAt: number,
  gmTimeAtResponse: number,
): ClockSample {
  const roundTripMs = Math.max(0, clientReceivedAt - clientSentAt);
  const localMidpoint = clientSentAt + roundTripMs / 2;
  return {
    roundTripMs,
    offsetGmMinusLocalMs: gmTimeAtResponse - localMidpoint,
  };
}

export function calculateLocalStartAt(
  startAtGm: number,
  issuedAtGm: number,
  localReceivedAt: number,
  offsetGmMinusLocalMs?: number,
): number {
  if (offsetGmMinusLocalMs !== undefined) {
    return startAtGm - offsetGmMinusLocalMs;
  }

  return localReceivedAt + Math.max(0, startAtGm - issuedAtGm);
}
