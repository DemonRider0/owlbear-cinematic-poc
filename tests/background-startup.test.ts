import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_ACTIVATION_CHANNEL,
  AUDIO_ACTIVATION_POPOVER_ID,
  BROADCAST_CHANNEL,
  MUSIC_ROOM_METADATA_KEY,
  PROTOCOL_VERSION,
} from "../src/config";
import { localAudioStorageKey } from "../src/local-audio-settings";
import {
  createInitialMusicState,
  createLayeredMusicState,
  getMusicLayer,
  isMusicState,
  musicLayerPositionAtGm,
  type MusicControlAction,
} from "../src/music-state";
import type { MusicPlaybackStatus } from "../src/protocol";

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
  getMetadata: vi.fn(),
  getPlayers: vi.fn(),
  openPopover: vi.fn(),
  closePopover: vi.fn(),
  showNotification: vi.fn(),
  applyMusicState: vi.fn(),
  retryAutoplay: vi.fn(),
  setMetadata: vi.fn(),
  setLocalVolumes: vi.fn(),
  initialVolumes: undefined as unknown,
  readyCallback: undefined as (() => void) | undefined,
  messageCallback: undefined as ((event: BroadcastEvent) => void) | undefined,
  activationCallback: undefined as ((event: BroadcastEvent) => void) | undefined,
  reportPlayback: undefined as ((status: MusicPlaybackStatus) => void) | undefined,
  maintenance: undefined as (() => void) | undefined,
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
      getPlayers: sdk.getPlayers,
      onChange: vi.fn(),
    },
    broadcast: {
      onMessage: vi.fn(
        (channel: string, callback: (event: BroadcastEvent) => void) => {
          if (channel === BROADCAST_CHANNEL) sdk.messageCallback = callback;
          if (channel === AUDIO_ACTIVATION_CHANNEL) sdk.activationCallback = callback;
        },
      ),
      sendMessage: sdk.sendMessage,
    },
    room: {
      getMetadata: sdk.getMetadata,
      setMetadata: sdk.setMetadata,
      onMetadataChange: vi.fn(),
    },
    tool: {
      create: sdk.createTool,
      remove: vi.fn(),
    },
    popover: {
      open: sdk.openPopover,
      close: sdk.closePopover,
    },
    notification: {
      show: sdk.showNotification,
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
    constructor(_clock: unknown, volumes: unknown, reportPlayback: (status: MusicPlaybackStatus) => void) {
      sdk.initialVolumes = volumes;
      sdk.reportPlayback = reportPlayback;
    }
    preload = vi.fn();
    applyState = sdk.applyMusicState;
    reconcile = vi.fn();
    retryAutoplay = sdk.retryAutoplay;
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
  await vi.waitFor(() => expect(["READY", "ERROR"]).toContain(lastReportedPhase()));
  if (await sdk.getRole() === "GM") {
    await vi.waitFor(() => expect(sdk.applyMusicState).toHaveBeenCalled());
  }
}

function lastReportedPhase(): unknown {
  return sdk.sendMessage.mock.calls.filter(([, message]) => message.kind === "CLIENT_STATUS").at(-1)?.[1].phase;
}

function sendControl(action: MusicControlAction, requestId: string, issuedAt: number, connectionId = "gm-connection"): void {
  sdk.messageCallback?.({
    connectionId,
    data: { version: PROTOCOL_VERSION, kind: "MUSIC_CONTROL", action, requestId, issuedAt },
  });
}

describe("background startup", () => {
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sdk.readyCallback = undefined;
    sdk.messageCallback = undefined;
    sdk.activationCallback = undefined;
    sdk.reportPlayback = undefined;
    sdk.maintenance = undefined;
    sdk.storageCallback = undefined;
    sdk.initialVolumes = undefined;
    sdk.getPlayerId.mockResolvedValue("player-local");
    sdk.getRole.mockResolvedValue("GM");
    sdk.sendMessage.mockResolvedValue(undefined);
    sdk.createTool.mockResolvedValue(undefined);
    sdk.openPopover.mockResolvedValue(undefined);
    sdk.closePopover.mockResolvedValue(undefined);
    sdk.showNotification.mockResolvedValue("notification");
    sdk.setMetadata.mockResolvedValue(undefined);
    sdk.getMetadata.mockResolvedValue({});
    sdk.getPlayers.mockResolvedValue([]);
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
      setTimeout(callback: () => void, delay: number) {
        const timer = setTimeout(() => {
          timeouts.delete(timer);
          callback();
        }, delay);
        timeouts.add(timer);
        return timer;
      },
      setInterval(callback: () => void) {
        sdk.maintenance = callback;
      },
    });
    vi.stubGlobal("navigator", { userAgent: "vitest" });
  });

  afterEach(() => {
    for (const timer of timeouts) clearTimeout(timer);
    timeouts.clear();
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

  it("serializes rapid controls, acknowledges duplicates and rejects commands issued out of order", async () => {
    media.preloadCinematic.mockResolvedValue({ readyState: 3 });
    await startBackground();
    sdk.applyMusicState.mockClear();
    sdk.sendMessage.mockClear();
    const now = Date.now();
    sendControl({ type: "ADD_TRACK", trackId: "wildfire" }, "a", now);
    sendControl({ type: "ADD_TRACK", trackId: "nightfire-ritual" }, "b", now + 1);
    sendControl({ type: "PAUSE_LAYER", trackId: "wildfire" }, "stale", now - 1);
    sendControl({ type: "ADD_TRACK", trackId: "nightfire-ritual" }, "b", now + 1);
    sendControl({ type: "ADD_TRACK", trackId: "nightfire-ritual" }, "no-op", now + 2);
    sendControl({ type: "REPLACE_TRACK", trackId: "what-remains" }, "player", now + 3, "player-connection");

    await vi.waitFor(() => expect(sdk.sendMessage.mock.calls.filter(
      ([, message]) => message.kind === "MUSIC_STATE",
    )).toHaveLength(5));
    const first = sdk.applyMusicState.mock.calls[0]?.[0];
    const final = sdk.applyMusicState.mock.calls[1]?.[0];
    expect(sdk.applyMusicState).toHaveBeenCalledTimes(2);
    expect(isMusicState(first) && isMusicState(final)).toBe(true);
    expect(final.revision).toBe(first.revision + 1);
    expect(getMusicLayer(final, "wildfire")).toEqual(getMusicLayer(first, "wildfire"));
    expect(getMusicLayer(final, "nightfire-ritual")?.anchorAtGm).toBeGreaterThan(
      getMusicLayer(final, "wildfire")?.anchorAtGm ?? 0,
    );
    expect(sdk.sendMessage.mock.calls.at(-1)?.[1].state.stateId).toBe(final.stateId);
    await vi.waitFor(() => expect(sdk.setMetadata.mock.calls.at(-1)?.[0][MUSIC_ROOM_METADATA_KEY].stateId).toBe(final.stateId));
  });

  it("takes over a persisted layered snapshot after the old GM connection disappears", async () => {
    media.preloadCinematic.mockResolvedValue({ readyState: 3 });
    const now = Date.now();
    const initial = createInitialMusicState("old-connection", "initial", now - 10_000);
    const first = createLayeredMusicState(
      initial, { type: "ADD_TRACK", trackId: "wildfire" }, "old-connection", "first", now - 9_500, now - 9_000,
    );
    const previous = createLayeredMusicState(
      first, { type: "ADD_TRACK", trackId: "what-remains" }, "old-connection", "second", now - 7_500, now - 7_000,
    );
    sdk.getMetadata.mockResolvedValue({ [MUSIC_ROOM_METADATA_KEY]: previous });
    await startBackground();
    expect(sdk.applyMusicState).toHaveBeenCalledOnce();
    const takenOver = sdk.applyMusicState.mock.lastCall?.[0];
    expect(isMusicState(takenOver)).toBe(true);
    expect(takenOver.authorityConnectionId).toBe("gm-connection");
    expect(takenOver.revision).toBe(previous.revision + 1);
    expect(musicLayerPositionAtGm(getMusicLayer(takenOver, "wildfire")!, now)).toBeCloseTo(9, 1);
    expect(musicLayerPositionAtGm(getMusicLayer(takenOver, "what-remains")!, now)).toBeCloseTo(7, 1);
  });

  it("recovers a player's three layers without mounting the panel or waiting for tool registration", async () => {
    const remote = "remote-gm";
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    sdk.getRole.mockResolvedValue("PLAYER");
    sdk.getPlayers.mockResolvedValue([{ connectionId: remote, role: "GM" }])
      .mockRejectedValueOnce(new Error("participantes temporariamente indisponíveis"));
    sdk.createTool.mockReturnValue(new Promise(() => undefined));
    media.preloadCinematic.mockResolvedValue({ readyState: 3 });
    let snapshot = createInitialMusicState(remote, "initial", now - 10_000);
    for (const [index, trackId] of (["wildfire", "tensao-pressagio", "perseguicao-frenetica"] as const).entries()) {
      const issued = now - 9_500 + index * 1_000;
      snapshot = createLayeredMusicState(
        snapshot, { type: "ADD_TRACK", trackId }, remote, trackId, issued, issued + 500,
      );
    }
    sdk.getMetadata.mockResolvedValue({ [MUSIC_ROOM_METADATA_KEY]: snapshot });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await startBackground();
    await vi.waitFor(() => expect(sdk.sendMessage.mock.calls.some(([, message]) => message.kind === "CLOCK_PING")).toBe(true));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Participantes indisponíveis"), expect.any(Error));
    expect(sdk.applyMusicState).not.toHaveBeenCalled();
    expect(sdk.openPopover).not.toHaveBeenCalled();

    // The first pings and the initial state request reached an unready GM.
    sdk.sendMessage.mockClear();
    clock.mockReturnValue(now + 5_000);
    sdk.maintenance?.();
    await vi.waitFor(() => expect(sdk.sendMessage.mock.calls.some(([, message]) => message.kind === "CLOCK_PING")).toBe(true));
    expect(sdk.sendMessage.mock.calls.some(([, message]) => message.kind === "MUSIC_STATE_REQUEST")).toBe(true);
    const ping = sdk.sendMessage.mock.calls.find(([, message]) => message.kind === "CLOCK_PING")?.[1];
    expect(ping.targetConnectionId).toBe(remote);
    sdk.sendMessage.mockImplementation((_channel, message) =>
      message.kind === "CLIENT_STATUS" && message.diagnostics.clock
        ? Promise.reject(new Error("diagnóstico indisponível"))
        : Promise.resolve(),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sdk.messageCallback?.({
      connectionId: remote,
      data: {
        version: PROTOCOL_VERSION,
        kind: "CLOCK_PONG",
        nonce: ping.nonce,
        targetConnectionId: "gm-connection",
        clientSentAt: ping.clientSentAt,
        gmTime: now + 6_700,
      },
    });
    await vi.waitFor(() => expect(sdk.applyMusicState).toHaveBeenCalledWith(snapshot));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Falha ao processar broadcast"), expect.any(Error));
    expect(sdk.openPopover).not.toHaveBeenCalled();
  });

  it("offers a compact activation only on local blocking and closes it after confirmed playback", async () => {
    media.preloadCinematic.mockResolvedValue({ readyState: 3 });
    await startBackground();
    sdk.setMetadata.mockClear();
    sdk.reportPlayback?.("STARTING");
    expect(sdk.openPopover).not.toHaveBeenCalled();
    sdk.reportPlayback?.("BLOCKED");
    await vi.waitFor(() => expect(sdk.openPopover).toHaveBeenCalledOnce());
    expect(sdk.openPopover).toHaveBeenCalledWith(expect.objectContaining({
      id: AUDIO_ACTIVATION_POPOVER_ID,
      url: "http://localhost:5173/audio-activation.html",
    }));
    sdk.reportPlayback?.("BLOCKED");
    sdk.activationCallback?.({ connectionId: "remote-player", data: "ACTIVATE" });
    expect(sdk.retryAutoplay).not.toHaveBeenCalled();
    sdk.activationCallback?.({ connectionId: "gm-connection", data: "ACTIVATE" });
    expect(sdk.retryAutoplay).toHaveBeenCalledOnce();
    expect(sdk.closePopover).not.toHaveBeenCalled();
    sdk.reportPlayback?.("PLAYING");
    await vi.waitFor(() => expect(sdk.closePopover).toHaveBeenCalledWith(AUDIO_ACTIVATION_POPOVER_ID));
    expect(sdk.openPopover).toHaveBeenCalledOnce();
    expect(sdk.setMetadata).not.toHaveBeenCalled();
  });

  it("keeps controls accessible to a local client while autoplay remains blocked", async () => {
    media.preloadCinematic.mockResolvedValue({ readyState: 3 });
    await startBackground();
    sdk.reportPlayback?.("BLOCKED");
    await vi.waitFor(() => expect(sdk.openPopover).toHaveBeenCalledOnce());
    sdk.activationCallback?.({ connectionId: "remote-player", data: "OPEN_CONTROLS" });
    expect(sdk.openPopover).toHaveBeenCalledOnce();
    sdk.activationCallback?.({ connectionId: "gm-connection", data: "OPEN_CONTROLS" });
    await vi.waitFor(() => expect(sdk.closePopover).toHaveBeenCalledWith(AUDIO_ACTIVATION_POPOVER_ID));
    expect(sdk.openPopover).toHaveBeenLastCalledWith(expect.objectContaining({
      url: "http://localhost:5173/controls.html",
      height: 720,
    }));
    expect(sdk.retryAutoplay).not.toHaveBeenCalled();
  });
});
