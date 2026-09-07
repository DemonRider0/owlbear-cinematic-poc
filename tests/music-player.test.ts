import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicPlayer } from "../src/music-player";
import {
  CINEMATIC_OUTRO_MUSIC,
  MUSIC_GAIN_STEP_MS,
  MUSIC_LOOP_CROSSFADE_MS,
  MUSIC_TRACK_CROSSFADE_MS,
  getMusicLoopCycleSeconds,
} from "../src/config";
import {
  createCinematicMusicState,
  createInitialMusicState,
  createManualMusicState,
  createPostCinematicMusicState,
} from "../src/music-state";

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];

  currentTime = 0;
  error: MediaError | null = null;
  deferPlay = false;
  loop = false;
  paused = true;
  preload = "";
  readyState = 4;
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
    expect(FakeAudio.instances).toHaveLength(4);
    expect(FakeAudio.instances.every((audio) => audio.loop === false)).toBe(true);
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
    const newTrack = audioAt(2);
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

    await vi.advanceTimersByTimeAsync(MUSIC_TRACK_CROSSFADE_MS / 2);
    expect(oldTrack.volume).toBeGreaterThan(0.65);
    expect(oldTrack.volume).toBeLessThan(0.75);
    expect(newTrack.volume).toBeGreaterThan(0.65);
    expect(newTrack.volume).toBeLessThan(0.75);

    await vi.advanceTimersByTimeAsync(
      MUSIC_TRACK_CROSSFADE_MS / 2 + 100,
    );
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
    const newTrack = audioAt(2);
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
    await vi.advanceTimersByTimeAsync(
      500 + MUSIC_TRACK_CROSSFADE_MS + 100,
    );

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

  it("fades manual music out and brings O Porão in without audible O Ídolo", async () => {
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
    const cinematicTrack = audioAt(2);
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
    expect(cinematicTrack.paused).toBe(true);
    expect(cinematicTrack.volume).toBe(0);
    expect(audioAt(3).paused).toBe(true);

    const handoff = cinematic.cinematic;
    const outro = handoff?.outro;
    await vi.advanceTimersByTimeAsync(
      (outro?.startAtGm ?? 0) - (handoff?.videoStartAtGm ?? 0),
    );
    expect(manualTrack.paused).toBe(false);
    expect(manualTrack.currentTime).toBeCloseTo(
      CINEMATIC_OUTRO_MUSIC.positionSeconds,
      3,
    );
    expect(manualTrack.volume).toBe(0);
    expect(cinematicTrack.paused).toBe(true);
    expect(audioAt(3).paused).toBe(true);

    await vi.advanceTimersByTimeAsync((outro?.durationMs ?? 0) / 2);
    expect(manualTrack.volume).toBeGreaterThan(0.16);
    expect(manualTrack.volume).toBeLessThan(0.19);
    expect(cinematicTrack.paused).toBe(true);

    await vi.advanceTimersByTimeAsync((outro?.durationMs ?? 0) / 2 + 50);
    expect(manualTrack.paused).toBe(false);
    expect(manualTrack.volume).toBeCloseTo(
      CINEMATIC_OUTRO_MUSIC.targetGain,
      7,
    );
    expect(cinematicTrack.paused).toBe(true);

    await vi.advanceTimersByTimeAsync(
      (handoff?.videoEndsAtGm ?? 0) - Date.now(),
    );
    const completed = createPostCinematicMusicState(
      cinematic,
      "gm-1",
      "manual-after-cinematic",
      handoff?.videoEndsAtGm ?? Number.NaN,
    );
    player.applyState(completed);
    await vi.advanceTimersByTimeAsync(0);
    expect(manualTrack.volume).toBeCloseTo(
      CINEMATIC_OUTRO_MUSIC.targetGain,
      7,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(manualTrack.volume).toBeCloseTo(0.368190418, 3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manualTrack.volume).toBeCloseTo(0.625594322, 3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manualTrack.volume).toBe(1);
    expect(cinematicTrack.paused).toBe(true);
    expect(audioAt(3).paused).toBe(true);
  });

  it("alternates two compressed voices across two scheduled seams", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const cycleSeconds = getMusicLoopCycleSeconds("o-porao");
    const seeked = createManualMusicState(
      initial,
      { type: "SEEK", positionSeconds: cycleSeconds - 1 },
      "gm-1",
      "seeked",
      1_000,
      1_000,
    );
    const playing = createManualMusicState(
      seeked,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    const voiceA = audioAt(0);
    const voiceB = audioAt(1);
    expect(voiceA.paused).toBe(false);
    expect(voiceB.paused).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(voiceA.paused).toBe(false);
    expect(voiceB.paused).toBe(false);
    expect(voiceA.volume).toBeCloseTo(1, 6);
    expect(voiceB.volume).toBeCloseTo(0, 6);

    await vi.advanceTimersByTimeAsync(160);
    expect(voiceA.volume).toBeGreaterThan(0.65);
    expect(voiceA.volume).toBeLessThan(0.75);
    expect(voiceB.volume).toBeGreaterThan(0.65);
    expect(voiceB.volume).toBeLessThan(0.75);

    await vi.advanceTimersByTimeAsync(
      MUSIC_LOOP_CROSSFADE_MS - 160 + MUSIC_GAIN_STEP_MS,
    );
    expect(voiceA.paused).toBe(true);
    expect(voiceB.paused).toBe(false);
    expect(voiceB.volume).toBe(1);

    await vi.advanceTimersByTimeAsync(
      cycleSeconds * 1_000 - MUSIC_LOOP_CROSSFADE_MS,
    );
    expect(voiceA.paused).toBe(false);
    expect(voiceB.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(MUSIC_LOOP_CROSSFADE_MS);
    expect(voiceA.paused).toBe(false);
    expect(voiceA.volume).toBe(1);
    expect(voiceB.paused).toBe(true);
  });

  it("reconstructs both voices when playback starts inside a loop seam", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const seeked = createManualMusicState(
      initial,
      { type: "SEEK", positionSeconds: 0.15 },
      "gm-1",
      "seeked",
      1_000,
      1_000,
    );
    const playing = createManualMusicState(
      seeked,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    const outgoing = audioAt(0);
    const incoming = audioAt(1);
    expect(outgoing.paused).toBe(false);
    expect(incoming.paused).toBe(false);
    expect(outgoing.currentTime).toBeCloseTo(
      getMusicLoopCycleSeconds("o-porao") + 0.15,
      6,
    );
    expect(incoming.currentTime).toBeCloseTo(0.15, 6);
    expect(outgoing.volume).toBeCloseTo(Math.SQRT1_2, 2);
    expect(incoming.volume).toBeCloseTo(Math.SQRT1_2, 2);

    await vi.advanceTimersByTimeAsync(160);
    expect(outgoing.paused).toBe(true);
    expect(incoming.paused).toBe(false);
    expect(incoming.volume).toBe(1);
  });

  it("does not mistake a delayed first start for a completed loop", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 0);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      0,
      900,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    const firstVoice = audioAt(0);
    const standbyVoice = audioAt(1);
    expect(firstVoice.paused).toBe(false);
    expect(firstVoice.currentTime).toBeCloseTo(0.1, 6);
    expect(firstVoice.volume).toBe(1);
    expect(standbyVoice.paused).toBe(true);
    expect(standbyVoice.volume).toBe(0);
  });

  it("keeps the old loop scheduler alive until an anchored pause applies", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const cycleSeconds = getMusicLoopCycleSeconds("o-porao");
    const seeked = createManualMusicState(
      initial,
      { type: "SEEK", positionSeconds: cycleSeconds - 0.2 },
      "gm-1",
      "seeked",
      1_000,
      1_000,
    );
    const playing = createManualMusicState(
      seeked,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    const paused = createManualMusicState(
      playing,
      { type: "PAUSE" },
      "gm-1",
      "paused",
      1_000,
      1_500,
    );
    player.applyState(paused);
    await vi.advanceTimersByTimeAsync(200);

    expect(audioAt(0).paused).toBe(false);
    expect(audioAt(1).paused).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    expect(audioAt(0).paused).toBe(true);
    expect(audioAt(1).paused).toBe(true);
    expect(audioAt(1).currentTime).toBeCloseTo(0.3, 6);
  });

  it("ignores a stale play promise after pause", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const voice = audioAt(0);
    voice.deferPlay = true;
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);

    const paused = createManualMusicState(
      playing,
      { type: "PAUSE" },
      "gm-1",
      "paused",
      1_000,
      1_000,
    );
    player.applyState(paused);
    voice.finishDeferredPlay();
    await Promise.resolve();
    await Promise.resolve();

    expect(voice.paused).toBe(true);
    expect(voice.volume).toBe(0);
  });

  it("composes a track crossfade with an outgoing loop seam", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const cycleSeconds = getMusicLoopCycleSeconds("o-porao");
    const seeked = createManualMusicState(
      initial,
      { type: "SEEK", positionSeconds: cycleSeconds - 1 },
      "gm-1",
      "seeked",
      1_000,
      1_000,
    );
    const playing = createManualMusicState(
      seeked,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    player.applyState(playing);
    const changed = createManualMusicState(
      playing,
      { type: "SELECT_TRACK", trackId: "o-idolo" },
      "gm-1",
      "changed",
      1_000,
      1_500,
    );
    player.applyState(changed);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(audioAt(0).paused).toBe(false);
    expect(audioAt(1).paused).toBe(false);
    expect(audioAt(2).paused).toBe(false);

    await vi.advanceTimersByTimeAsync(160);
    expect(audioAt(0).volume).toBeGreaterThan(0);
    expect(audioAt(0).volume).toBeLessThan(1);
    expect(audioAt(1).volume).toBeGreaterThan(0);
    expect(audioAt(1).volume).toBeLessThan(1);
    expect(audioAt(2).volume).toBeGreaterThan(0);
    expect(audioAt(2).volume).toBeLessThan(1);

    await vi.advanceTimersByTimeAsync(MUSIC_TRACK_CROSSFADE_MS);
    expect(audioAt(0).paused).toBe(true);
    expect(audioAt(1).paused).toBe(true);
    expect(audioAt(2).paused).toBe(false);
    expect(audioAt(2).volume).toBe(1);
  });

});
