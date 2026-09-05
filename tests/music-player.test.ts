import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicPlayer } from "../src/music-player";
import {
  createCinematicMusicState,
  createInitialMusicState,
  createManualMusicState,
} from "../src/music-state";

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];

  currentTime = 0;
  error: MediaError | null = null;
  deferPlay = false;
  loop = false;
  paused = true;
  preload = "";
  src = "";
  volume = 1;
  private resolveDeferredPlay: (() => void) | undefined;

  constructor() {
    super();
    FakeAudio.instances.push(this);
  }

  load(): void {}

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    this.paused = false;
    if (this.deferPlay) {
      return new Promise((resolve) => {
        this.resolveDeferredPlay = resolve;
      });
    }
    return Promise.resolve();
  }

  finishDeferredPlay(): void {
    this.resolveDeferredPlay?.();
    this.resolveDeferredPlay = undefined;
  }
}

describe("persistent music player", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("window", {
      clearTimeout,
      location: { href: "https://example.test/background.html" },
      setTimeout,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createPlayer(): MusicPlayer {
    return new MusicPlayer({
      gmNow: () => Date.now(),
      toLocalTime: (gmTime) => gmTime,
    });
  }

  function audioAt(index: number): FakeAudio {
    const audio = FakeAudio.instances[index];
    if (!audio) {
      throw new Error(`Áudio de teste ausente no índice ${index}.`);
    }
    return audio;
  }

  it("keeps the previous track alive through a synchronized crossfade", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    const oldTrack = audioAt(0);
    const newTrack = audioAt(1);
    expect(oldTrack.paused).toBe(false);
    expect(oldTrack.volume).toBe(1);

    const changed = createManualMusicState(
      playing,
      { type: "SELECT_TRACK", trackId: "o-idolo" },
      "gm-1",
      "changed",
      1_000,
      1_500,
    );
    player.applyState(changed);
    await vi.advanceTimersByTimeAsync(500);

    expect(oldTrack.paused).toBe(false);
    expect(newTrack.paused).toBe(false);
    expect(oldTrack.volume).toBeCloseTo(1, 6);
    expect(newTrack.volume).toBeCloseTo(0, 6);

    await vi.advanceTimersByTimeAsync(900);
    expect(oldTrack.volume).toBeGreaterThan(0.65);
    expect(oldTrack.volume).toBeLessThan(0.75);
    expect(newTrack.volume).toBeGreaterThan(0.65);
    expect(newTrack.volume).toBeLessThan(0.75);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(oldTrack.paused).toBe(true);
    expect(oldTrack.volume).toBe(0);
    expect(newTrack.paused).toBe(false);
    expect(newTrack.volume).toBe(1);
  });

  it("applies pause and seek only at their shared anchor", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);
    const track = audioAt(0);

    const paused = createManualMusicState(
      playing,
      { type: "PAUSE" },
      "gm-1",
      "paused",
      1_000,
      1_500,
    );
    player.applyState(paused);
    await vi.advanceTimersByTimeAsync(499);
    expect(track.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(track.paused).toBe(true);
    expect(track.currentTime).toBeCloseTo(0.5, 6);

    const seeked = createManualMusicState(
      paused,
      { type: "SEEK", positionSeconds: 92.25 },
      "gm-1",
      "seeked",
      1_500,
      2_000,
    );
    const resumed = createManualMusicState(
      seeked,
      { type: "PLAY" },
      "gm-1",
      "resumed",
      1_500,
      2_000,
    );
    player.applyState(resumed);
    await vi.advanceTimersByTimeAsync(499);
    expect(track.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(track.paused).toBe(false);
    expect(track.currentTime).toBeCloseTo(92.25, 6);
  });

  it("keeps the old track audible until a delayed replacement really starts", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    const oldTrack = audioAt(0);
    const newTrack = audioAt(1);
    newTrack.deferPlay = true;
    const changed = createManualMusicState(
      playing,
      { type: "SELECT_TRACK", trackId: "o-idolo" },
      "gm-1",
      "changed",
      1_000,
      1_500,
    );
    player.applyState(changed);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(oldTrack.paused).toBe(false);
    expect(oldTrack.volume).toBe(1);
    expect(newTrack.volume).toBe(0);

    newTrack.finishDeferredPlay();
    await Promise.resolve();
    await Promise.resolve();
    expect(oldTrack.paused).toBe(true);
    expect(newTrack.paused).toBe(false);
    expect(newTrack.volume).toBe(1);
  });

  it("fades manual music out, runs the cinematic track silently and hands it off", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    const manualTrack = audioAt(0);
    const cinematicTrack = audioAt(1);
    const cinematic = createCinematicMusicState(
      "gm-1",
      "cinematic",
      2,
      1_000,
      2_500,
    );
    player.applyState(cinematic);

    await vi.advanceTimersByTimeAsync(520);
    expect(manualTrack.paused).toBe(true);
    expect(manualTrack.volume).toBe(0);

    await vi.advanceTimersByTimeAsync(980);
    expect(cinematicTrack.paused).toBe(false);
    expect(cinematicTrack.volume).toBe(0);
    expect(cinematicTrack.currentTime).toBeCloseTo(308.847, 3);

    await vi.advanceTimersByTimeAsync(33_800);
    expect(cinematicTrack.volume).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(cinematicTrack.volume).toBeGreaterThan(0.65);
    expect(cinematicTrack.volume).toBeLessThan(0.75);
    await vi.advanceTimersByTimeAsync(500);
    expect(cinematicTrack.paused).toBe(false);
    expect(cinematicTrack.volume).toBe(1);
  });
});
