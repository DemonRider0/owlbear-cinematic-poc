import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../src/config";
import { localAudioStorageKey } from "../src/local-audio-settings";
import { createInitialMusicState } from "../src/music-state";

interface BroadcastEvent {
  connectionId: string;
  data: unknown;
}

const sdk = vi.hoisted(() => ({
  onReady: vi.fn(),
  sendMessage: vi.fn(),
  createTool: vi.fn(),
  getPlayerId: vi.fn(),
  getRole: vi.fn(),
  openPopover: vi.fn(),
  applyMusicState: vi.fn(),
  setMetadata: vi.fn(),
  setLocalVolumes: vi.fn(),
  initialVolumes: undefined as unknown,
  readyCallback: undefined as (() => void) | undefined,
  messageCallback: undefined as ((event: BroadcastEvent) => void) | undefined,
  storageCallback: undefined as ((event: StorageEvent) => void) | undefined,
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
      getId: sdk.getPlayerId,
      getName: vi.fn().mockResolvedValue("GM"),
      getRole: sdk.getRole,
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
      open: sdk.openPopover,
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
    constructor(_clock: unknown, volumes: unknown) {
      sdk.initialVolumes = volumes;
    }
    preload = vi.fn();
    applyState = sdk.applyMusicState;
    reconcile = vi.fn();
    setLocalVolumes = sdk.setLocalVolumes;
  },
}));

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

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
    sdk.storageCallback = undefined;
    sdk.initialVolumes = undefined;
    sdk.getPlayerId.mockResolvedValue("player-local");
    sdk.getRole.mockResolvedValue("GM");
    sdk.sendMessage.mockResolvedValue(undefined);
    sdk.createTool.mockResolvedValue(undefined);
    sdk.openPopover.mockResolvedValue(undefined);
    sdk.setMetadata.mockResolvedValue(undefined);
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      addEventListener(
        eventName: string,
        callback: (event: StorageEvent) => void,
      ) {
        if (eventName === "storage") {
          sdk.storageCallback = callback;
        }
      },
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
    expect(sdk.createTool).toHaveBeenCalledWith(
      expect.objectContaining({
        icons: [
          expect.objectContaining({
            filter: { roles: ["GM", "PLAYER"] },
          }),
        ],
      }),
    );
    expect(media.preloadCinematic).toHaveBeenCalledWith(
      "http://localhost:5173/assets/cinematic.mp4?cinematic-cache=v2",
    );
    expect(lastReportedPhase()).toBe("READY");
  });

  it("allows a PLAYER to open the compact volume panel", async () => {
    media.preloadCinematic.mockResolvedValue({
      bytes: 10_199_007,
      readyState: 3,
    });
    await startBackground();
    sdk.getRole.mockResolvedValue("PLAYER");

    const tool = sdk.createTool.mock.calls[0]?.[0] as {
      onClick: (context: unknown, elementId: string) => Promise<boolean>;
    };
    await tool.onClick({}, "tool-element");

    expect(sdk.openPopover).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:5173/controls.html",
        height: 260,
      }),
    );
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

  it("loads and applies local volume changes without touching shared state", async () => {
    media.preloadCinematic.mockResolvedValue({
      bytes: 10_199_007,
      readyState: 3,
    });
    localStorage.setItem(
      localAudioStorageKey("player-local"),
      JSON.stringify({ musicVolume: 0.3, effectsVolume: 0.25 }),
    );
    await startBackground();

    expect(sdk.initialVolumes).toEqual({
      musicVolume: 0.3,
      effectsVolume: 0.25,
    });
    sdk.setMetadata.mockClear();
    sdk.sendMessage.mockClear();
    sdk.setLocalVolumes.mockClear();

    sdk.storageCallback?.({
      key: localAudioStorageKey("player-local"),
      newValue: JSON.stringify({
        musicVolume: 0.6,
        effectsVolume: 0.4,
      }),
    } as StorageEvent);

    expect(sdk.setLocalVolumes).toHaveBeenCalledWith({
      musicVolume: 0.6,
      effectsVolume: 0.4,
    });
    expect(sdk.setMetadata).not.toHaveBeenCalled();
    expect(sdk.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores legacy shared volumes received by Broadcast", async () => {
    media.preloadCinematic.mockResolvedValue({
      bytes: 10_199_007,
      readyState: 3,
    });
    await startBackground();
    sdk.applyMusicState.mockClear();
    sdk.setLocalVolumes.mockClear();

    const legacyState = {
      ...createInitialMusicState(
        "gm-connection",
        "legacy-broadcast",
        Date.now() + 10_000,
      ),
      revision: 10,
      musicVolume: 0,
      effectsVolume: 0.25,
    };
    sdk.messageCallback?.({
      connectionId: "gm-connection",
      data: {
        version: PROTOCOL_VERSION,
        kind: "MUSIC_STATE",
        issuedAt: Date.now(),
        state: legacyState,
      },
    });

    await vi.waitFor(() =>
      expect(
        sdk.applyMusicState.mock.calls.some(
          ([state]) => state?.stateId === "legacy-broadcast",
        ),
      ).toBe(true),
    );
    const appliedState = sdk.applyMusicState.mock.calls.find(
      ([state]) => state?.stateId === "legacy-broadcast",
    )?.[0];
    expect(appliedState).not.toHaveProperty("musicVolume");
    expect(appliedState).not.toHaveProperty("effectsVolume");
    expect(sdk.setLocalVolumes).not.toHaveBeenCalled();

    sdk.sendMessage.mockClear();
    sdk.messageCallback?.({
      connectionId: "gm-connection",
      data: {
        version: PROTOCOL_VERSION,
        kind: "MUSIC_STATE_REQUEST",
        requestId: "legacy-state-request",
        issuedAt: Date.now(),
      },
    });
    await vi.waitFor(() =>
      expect(
        sdk.sendMessage.mock.calls.some(
          ([, message]) => message?.kind === "MUSIC_STATE",
        ),
      ).toBe(true),
    );
    const rebroadcastState = sdk.sendMessage.mock.calls.find(
      ([, message]) => message?.kind === "MUSIC_STATE",
    )?.[1]?.state;
    expect(rebroadcastState).not.toHaveProperty("musicVolume");
    expect(rebroadcastState).not.toHaveProperty("effectsVolume");
  });
});
