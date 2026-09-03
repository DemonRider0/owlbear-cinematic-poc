import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  onReady: vi.fn(),
  sendMessage: vi.fn(),
  createTool: vi.fn(),
  readyCallback: undefined as (() => void) | undefined,
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
      onMessage: vi.fn(),
      sendMessage: sdk.sendMessage,
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

async function startBackground(): Promise<void> {
  await import("../src/background");
  expect(sdk.onReady).toHaveBeenCalledOnce();
  sdk.readyCallback?.();
  await vi.waitFor(() => expect(sdk.sendMessage).toHaveBeenCalledTimes(2));
}

function lastReportedPhase(): unknown {
  return sdk.sendMessage.mock.calls.at(-1)?.[1]?.phase;
}

describe("background startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sdk.readyCallback = undefined;
    sdk.sendMessage.mockResolvedValue(undefined);
    sdk.createTool.mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      location: { href: "http://localhost:5173/background.html" },
      setTimeout,
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
      "http://localhost:5173/assets/cinematic.mp4?cinematic-cache=poc-1",
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
});
