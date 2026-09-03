import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/config";
import {
  isProtocolMessage,
  protocolMessage,
  type PlayMessage,
} from "../src/protocol";

describe("broadcast protocol", () => {
  it("builds and accepts a valid PLAY message", () => {
    const message = protocolMessage<PlayMessage>({
      kind: "PLAY",
      requestId: "request-1",
      issuedAt: 1_000,
      startAtGm: 2_500,
    });

    expect(message.version).toBe(PROTOCOL_VERSION);
    expect(isProtocolMessage(message)).toBe(true);
  });

  it("rejects malformed, stale and impossible messages", () => {
    expect(isProtocolMessage(null)).toBe(false);
    expect(
      isProtocolMessage({
        version: PROTOCOL_VERSION + 1,
        kind: "HELLO",
        requestId: "request-1",
        issuedAt: 1_000,
      }),
    ).toBe(false);
    expect(
      isProtocolMessage({
        version: PROTOCOL_VERSION,
        kind: "PLAY",
        requestId: "request-1",
        issuedAt: 2_000,
        startAtGm: 1_000,
      }),
    ).toBe(false);
    expect(
      isProtocolMessage({
        version: PROTOCOL_VERSION,
        kind: "CLIENT_STATUS",
        phase: "IMPOSSIBLE",
        source: "BACKGROUND",
        reportedAt: 1_000,
        diagnostics: {},
      }),
    ).toBe(false);
  });
});
