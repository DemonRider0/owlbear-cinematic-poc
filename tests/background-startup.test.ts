import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROADCAST_CHANNEL,
  MUSIC_ROOM_METADATA_KEY,
  PROTOCOL_VERSION,
} from "../src/config";

interface BroadcastEvent {
  connectionId: string;
  data: unknown;
}

const sdk = vi.hoisted(() => ({
  onReady: vi.fn(),
  sendMessage: vi.fn(),
  createTool: vi.fn(),
  setMetadata: vi.fn(),
  readyCallback: undefined as (() => void) | undefined,
  messageCallback: undefined as ((event: BroadcastEvent) => void) | undefined,
}));

const media = vi.hoisted(() => ({
  preloadCinematic: vi.fn(),
}));

vi.mock("@owlbear-rodeo/sdk", () => ({
  default: {
    onReady(callback: () => void) {
      sdk.onReady(callback);
      sdk.readyCallback = callback;
    },
    player: {
      getConnectionId: vi.fn().mockResolvedValue("gm-connection"),
      getName: vi.fn().mockResolvedValue("GM"),
      getRole: vi.fn().mockResolvedValue("GM"),
      onChange: vi.fn(),
    },
    party: {
      getPlayers: vi.fn().mockResolvedValue([]),
      onChange: vi.fn(),
    },
    broadcast: {
      onMessage: vi.fn(
        (_channel: string, callback: (event: BroadcastEvent) => void) => {
          sdk.messageCallback = callback;
        },
      ),
      sendMessage: sdk.sendMessage,
    },
    room: {
      getMetadata: vi.fn().mockResolvedValue({}),
      setMetadata: sdk.setMetadata,
      onMetadataChange: vi.fn(),
    },
    tool: {
      create: sdk.createTool,
      remove: vi.fn(),
    },
    popover: {
      open: vi.fn(),
    },
    modal: {
      open: vi.fn(),
    },
  },
}));

vi.mock("../src/media-cache", () => ({
  preloadCinematic: media.preloadCinematic,
}));

vi.mock("../src/music-player", () => ({
  MusicPlayer: class {
    preload = vi.fn();
    applyState = vi.fn();
    reconcile = vi.fn();
  },
}));

async function startBackground(): Promise<void> {
  await import("../src/background");
  expect(sdk.onReady).toHaveBeenCalledOnce();
  sdk.readyCallback?.();
  await vi.waitFor(() =>
    expect(sdk.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(4),
  );
}

function lastReportedPhase(): unknown {
  return sdk.sendMessage.mock.calls.at(-1)?.[1]?.phase;
}

describe("background startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sdk.readyCallback = undefined;
    sdk.messageCallback = undefined;
    sdk.sendMessage.mockResolvedValue(undefined);
    sdk.createTool.mockResolvedValue(undefined);
    sdk.setMetadata.mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      location: { href: "http://localhost:5173/background.html" },
      setTimeout,
      setInterval,
    });
    vi.stubGlobal("navigator", { userAgent: "vitest" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers the GM Tool and becomes READY when preload succeeds", async () => {
    media.preloadCinematic.mockResolvedValue({
      bytes: 10_199_007,
      readyState: 3,
    });

    await startBackground();

    expect(sdk.createTool).toHaveBeenCalledOnce();
    expect(media.preloadCinematic).toHaveBeenCalledWith(
      "http://localhost:5173/assets/cinematic.mp4?cinematic-cache=v2",
    );
    expect(lastReportedPhase()).toBe("READY");
  });

  it("keeps the background initialized and reports ERROR when preload fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    media.preloadCinematic.mockRejectedValue(new Error("MP4 indisponível"));

    await startBackground();

    expect(sdk.createTool).toHaveBeenCalledOnce();
    expect(lastReportedPhase()).toBe("ERROR");
    expect(
      consoleError.mock.calls.some(([message]) =>
        String(message).includes("Inicialização do background falhou"),
      ),
    ).toBe(false);
  });

  it("persists and broadcasts independent volume updates in the shared music state", async () => {
    media.preloadCinematic.mockResolvedValue({
      bytes: 10_199_007,
      readyState: 3,
    });
    await startBackground();

    const initialMetadata = sdk.setMetadata.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    const initialState = initialMetadata?.[MUSIC_ROOM_METADATA_KEY] as
      | { stateId?: string }
      | undefined;
    sdk.setMetadata.mockClear();
    sdk.sendMessage.mockClear();

    sdk.messageCallback?.({
      connectionId: "gm-connection",
      data: {
        version: PROTOCOL_VERSION,
        kind: "MUSIC_CONTROL",
        requestId: "volume-control",
        issuedAt: Date.now(),
        action: {
          type: "SET_VOLUMES",
          musicVolume: 0.5,
          effectsVolume: 0.25,
        },
      },
    });

    await vi.waitFor(() => expect(sdk.setMetadata).toHaveBeenCalledOnce());
    const metadata = sdk.setMetadata.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const state = metadata[MUSIC_ROOM_METADATA_KEY] as {
      stateId: string;
      musicVolume: number;
      effectsVolume: number;
    };
    expect(state.stateId).toBe(initialState?.stateId);
    expect(state.musicVolume).toBe(0.5);
    expect(state.effectsVolume).toBe(0.25);
    await vi.waitFor(() =>
      expect(sdk.sendMessage).toHaveBeenCalledWith(
        BROADCAST_CHANNEL,
        expect.objectContaining({
          kind: "MUSIC_STATE",
          state: expect.objectContaining({
            musicVolume: 0.5,
            effectsVolume: 0.25,
          }),
        }),
        { destination: "ALL" },
      ),
    );
  });
});
