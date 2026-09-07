import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/config";
import { createCinematicMusicState } from "../src/music-state";
import {
  isProtocolMessage,
  protocolMessage,
  type MusicControlMessage,
  type MusicStateMessage,
  type MusicStateRequestMessage,
  type PlayMessage,
} from "../src/protocol";

describe("broadcast protocol", () => {
  it("builds and accepts a valid PLAY message", () => {
    const musicState = createCinematicMusicState(
      "gm-1",
      "request-1",
      1,
      1_000,
      2_500,
    );
    const message = protocolMessage<PlayMessage>({
      kind: "PLAY",
      requestId: "request-1",
      issuedAt: 1_000,
      startAtGm: 2_500,
      musicState,
    });

    expect(message.version).toBe(PROTOCOL_VERSION);
    expect(isProtocolMessage(message)).toBe(true);
  });

  it("accepts anchored music control, snapshot and acquisition messages", () => {
    const state = createCinematicMusicState(
      "gm-1",
      "cinematic-1",
      3,
      10_000,
      11_500,
    );
    const control = protocolMessage<MusicControlMessage>({
      kind: "MUSIC_CONTROL",
      requestId: "control-1",
      issuedAt: 9_000,
      action: { type: "SEEK", positionSeconds: 42.5 },
    });
    const emfControl = protocolMessage<MusicControlMessage>({
      kind: "MUSIC_CONTROL",
      requestId: "emf-control-1",
      issuedAt: 9_001,
      action: { type: "PLAY_EMF", emfId: "emf-1" },
    });
    const snapshot = protocolMessage<MusicStateMessage>({
      kind: "MUSIC_STATE",
      issuedAt: 10_001,
      state,
    });
    const request = protocolMessage<MusicStateRequestMessage>({
      kind: "MUSIC_STATE_REQUEST",
      requestId: "state-request-1",
      issuedAt: 10_002,
    });

    expect(isProtocolMessage(control)).toBe(true);
    expect(isProtocolMessage(emfControl)).toBe(true);
    expect(isProtocolMessage(snapshot)).toBe(true);
    expect(isProtocolMessage(request)).toBe(true);
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
    expect(
      isProtocolMessage({
        version: PROTOCOL_VERSION,
        kind: "MUSIC_CONTROL",
        requestId: "request-1",
        issuedAt: 1_000,
        action: { type: "SEEK", positionSeconds: -1 },
      }),
    ).toBe(false);
    expect(
      isProtocolMessage({
        version: PROTOCOL_VERSION,
        kind: "MUSIC_CONTROL",
        requestId: "request-1",
        issuedAt: 1_000,
        action: { type: "PLAY_EMF", emfId: "emf-4" },
      }),
    ).toBe(false);
  });
});
