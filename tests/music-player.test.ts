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
  createEmfMusicState,
  createInitialMusicState,
  createManualMusicState,
  createPostCinematicMusicState,
  musicGainAtGm,
} from "../src/music-state";
import type { LocalAudioVolumes } from "../src/local-audio-settings";
import { sha256, type LocalSessionSource } from "../src/local-session-source";

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];

  error: MediaError | null = null;
  deferPlay = false;
  loop = false;
  paused = true;
  pauseCalls = 0;
  playCalls = 0;
  preload = "";
  readyState = 4;
  seekCalls = 0;
  src = "";
  volume = 1;
  private mediaTime = 0;
  private resolveDeferredPlay: (() => void) | undefined;

  constructor() {
    super();
    FakeAudio.instances.push(this);
  }

  load(): void {}
  removeAttribute(): void { this.src = ""; }

  get currentTime(): number {
    return this.mediaTime;
  }

  set currentTime(value: number) {
    this.mediaTime = value;
    this.seekCalls += 1;
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  play(): Promise<void> {
    this.playCalls += 1;
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
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createPlayer(volumes?: LocalAudioVolumes): MusicPlayer {
    return new MusicPlayer(
      {
        gmNow: () => Date.now(),
        toLocalTime: (gmTime) => gmTime,
      },
      volumes,
    );
  }

  function audioAt(index: number): FakeAudio {
    const audio = FakeAudio.instances[index];
    if (!audio) {
      throw new Error(`Áudio de teste ausente no índice ${index}.`);
    }
    return audio;
  }

  it("plays resolved local audio on the existing clock with only local Trilhas volume, pause and seek", async () => {
    const player = createPlayer({ musicVolume: 0.5, effectsVolume: 0.9 });
    const blob = new Blob(["local audio"], { type: "audio/ogg" });
    const source: LocalSessionSource = { kind: "LOCAL_SESSION", sessionTrackId: "local", name: "Local.ogg",
      size: blob.size, sha256: await sha256(blob), mime: "audio/ogg", durationSeconds: 60,
      ownerConnectionId: "gm-1", ownerPlayerId: "gm" };
    const initial = { ...createInitialMusicState("gm-1", "local-paused", 1_000), source };
    await player.setResolvedSource(source, blob);
    player.applyState(initial);
    const playing = createManualMusicState(initial, { type: "PLAY" }, "gm-1", "local-play", 1_000, 1_500);
    player.applyState(playing);
    const local = FakeAudio.instances.at(-1)!;
    expect(local.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(local.paused).toBe(false);
    expect(local.volume).toBe(0.5);
    expect(audioAt(0).paused).toBe(true);
    player.setLocalVolumes({ musicVolume: 0.5, effectsVolume: 0 });
    expect(local.volume).toBe(0.5);
    const seek = createManualMusicState(playing, { type: "SEEK", positionSeconds: 25 }, "gm-1", "local-seek", 1_500, 2_000);
    player.applyState(seek);
    await vi.advanceTimersByTimeAsync(500);
    expect(local.currentTime).toBe(25);
    const pause = createManualMusicState(seek, { type: "PAUSE" }, "gm-1", "local-pause", 2_000, 2_500);
    player.applyState(pause);
    await vi.advanceTimersByTimeAsync(500);
    expect(local.paused).toBe(true);
    expect(await sha256(blob)).toBe(source.sha256);
    const builtin = createManualMusicState(pause, { type: "SELECT_TRACK", trackId: "o-porao" }, "gm-1", "builtin", 2_500, 2_500);
    expect(builtin.source).toBeUndefined();
    player.applyState(createManualMusicState(builtin, { type: "PLAY" }, "gm-1", "builtin-play", 2_500, 2_500));
    await vi.advanceTimersByTimeAsync(0);
    expect(local.paused).toBe(true);
    expect(audioAt(0).paused).toBe(false);
    player.clearResolvedSource();
    expect(local.src).toBe("");
  });

  it("joins current local playback using the GM offset and preserves cinematic and EMF exclusivity", async () => {
    const blob = new Blob(["local audio"], { type: "audio/ogg" });
    const source: LocalSessionSource = { kind: "LOCAL_SESSION", sessionTrackId: "local", name: "Local.ogg",
      size: blob.size, sha256: await sha256(blob), mime: "audio/ogg", durationSeconds: 60,
      ownerConnectionId: "gm-1", ownerPlayerId: "gm" };
    const player = new MusicPlayer({ gmNow: () => Date.now() + 400, toLocalTime: (gmTime) => gmTime - 400 });
    const playing = { ...createInitialMusicState("gm-1", "late", 500), source, playing: true, positionSeconds: 12, anchorAtGm: 500 };
    await player.setResolvedSource(source, blob);
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);
    const local = FakeAudio.instances.at(-1)!;
    expect(local.currentTime).toBeCloseTo(12.9);
    player.applyState(createEmfMusicState(playing, "emf-1", "gm-1", "emf", 1_400, 1_400));
    await vi.advanceTimersByTimeAsync(0);
    expect(local.paused).toBe(true);
    player.applyState({ ...playing, stateId: "again" });
    await vi.advanceTimersByTimeAsync(0);
    expect(local.paused).toBe(false);
    player.applyState(createCinematicMusicState("gm-1", "cinematic", 10, 1_400, 2_000));
    expect(local.paused).toBe(true);
    player.clearResolvedSource();
  });

  it("does not reuse an audio element that failed preparation and cleans its object URL", async () => {
    const player = createPlayer();
    const blob = new Blob(["local audio"], { type: "audio/ogg" });
    const source: LocalSessionSource = { kind: "LOCAL_SESSION", sessionTrackId: "retry", name: "Retry.ogg",
      size: blob.size, sha256: await sha256(blob), mime: "audio/ogg", durationSeconds: 60,
      ownerConnectionId: "gm-1", ownerPlayerId: "gm" };
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    vi.spyOn(FakeAudio.prototype, "load").mockImplementation(function (this: FakeAudio) { this.readyState = 0; });
    const first = player.setResolvedSource(source, blob);
    const firstRejected = expect(first).rejects.toThrow("não preparou");
    FakeAudio.instances.at(-1)!.dispatchEvent(new Event("error"));
    await firstRejected;
    expect(revoke).toHaveBeenCalledOnce();
    const old = FakeAudio.instances.at(-1);
    const retry = player.setResolvedSource(source, blob);
    let ready = false;
    void retry.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    const fresh = FakeAudio.instances.at(-1)!;
    expect(fresh).not.toBe(old);
    fresh.readyState = 4; fresh.dispatchEvent(new Event("canplay"));
    await retry;
    player.clearResolvedSource();
  });

  it("keeps the current local track audible while another import is prepared, until its scheduled selection", async () => {
    const player = createPlayer();
    const blob = new Blob(["abc"], { type: "audio/ogg" });
    const source: LocalSessionSource = { kind: "LOCAL_SESSION", sessionTrackId: "first", name: "First.ogg",
      size: blob.size, sha256: await sha256(blob), mime: "audio/ogg", durationSeconds: 60,
      ownerConnectionId: "gm-1", ownerPlayerId: "gm" };
    const playing = { ...createInitialMusicState("gm-1", "first-play", 1_000), source, playing: true };
    await player.setResolvedSource(source, blob);
    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeAudio.instances.at(-1)!;
    const nextSource = { ...source, sessionTrackId: "second", name: "Second.ogg" };
    await player.setResolvedSource(nextSource, blob);
    const second = FakeAudio.instances.at(-1)!;
    expect(first.paused).toBe(false);
    expect(first.src).not.toBe("");
    expect(second.paused).toBe(true);
    player.setLocalVolumes({ musicVolume: 0.4, effectsVolume: 0 });
    expect(first.volume).toBe(0.4);
    player.applyState({ ...playing, stateId: "second-play", source: nextSource, anchorAtGm: 1_500 });
    await vi.advanceTimersByTimeAsync(499);
    expect(first.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.paused).toBe(true);
    expect(first.src).toBe("");
    expect(second.paused).toBe(false);
    player.clearResolvedSource();
  });

  it("can play an incorporated EMF while the local track is still missing", async () => {
    const player = createPlayer();
    const source: LocalSessionSource = { kind: "LOCAL_SESSION", sessionTrackId: "missing", name: "Missing.ogg",
      size: 3, sha256: "a".repeat(64), mime: "audio/ogg", durationSeconds: 60,
      ownerConnectionId: "gm-1", ownerPlayerId: "gm" };
    const pending = { ...createInitialMusicState("gm-1", "missing-state", 1_000), source };
    player.applyState(createEmfMusicState(pending, "emf-1", "gm-1", "emf-without-local", 1_000, 1_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(audioAt(4).paused).toBe(false);
  });

  it("starts O Porão audibly at local 100% even when shared legacy volume is zero", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = {
      ...createManualMusicState(
        initial,
        { type: "PLAY" },
        "gm-1",
        "playing",
        1_000,
        1_000,
      ),
      musicVolume: 0,
      effectsVolume: 0,
    };

    player.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    expect(audioAt(0).paused).toBe(false);
    expect(audioAt(0).playCalls).toBe(1);
    expect(audioAt(0).volume).toBe(1);
  });

  it("applies independent local volumes without restarting, pausing or seeking", async () => {
    const player = createPlayer({ musicVolume: 1, effectsVolume: 1 });
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

    const music = audioAt(0);
    const emf = audioAt(4);
    music.currentTime = 12.5;
    const playCalls = music.playCalls;
    const pauseCalls = music.pauseCalls;
    const seekCalls = music.seekCalls;

    player.setLocalVolumes({ musicVolume: 0.5, effectsVolume: 1 });
    expect(music.volume).toBe(0.5);
    expect(emf.volume).toBe(1);

    player.setLocalVolumes({ musicVolume: 0.5, effectsVolume: 0.25 });
    expect(music.volume).toBe(0.5);
    expect(emf.volume).toBe(0.25);

    player.setLocalVolumes({ musicVolume: 0, effectsVolume: 0.25 });
    expect(music.volume).toBe(0);
    expect(music.paused).toBe(false);
    expect(music.currentTime).toBe(12.5);
    expect(music.playCalls).toBe(playCalls);
    expect(music.pauseCalls).toBe(pauseCalls);
    expect(music.seekCalls).toBe(seekCalls);
  });

  it("changes and mutes local EMF gain without interrupting its one-shot", async () => {
    const player = createPlayer({ musicVolume: 1, effectsVolume: 1 });
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const emfState = createEmfMusicState(
      initial,
      "emf-1",
      "gm-1",
      "emf-playing",
      1_000,
      1_000,
    );
    player.applyState(emfState);
    await vi.advanceTimersByTimeAsync(0);

    const emf = audioAt(4);
    const playCalls = emf.playCalls;
    const pauseCalls = emf.pauseCalls;
    const seekCalls = emf.seekCalls;
    player.setLocalVolumes({ musicVolume: 1, effectsVolume: 0.5 });
    expect(emf.volume).toBe(0.5);
    player.setLocalVolumes({ musicVolume: 1, effectsVolume: 0 });
    expect(emf.volume).toBe(0);
    expect(emf.paused).toBe(false);
    expect(emf.playCalls).toBe(playCalls);
    expect(emf.pauseCalls).toBe(pauseCalls);
    expect(emf.seekCalls).toBe(seekCalls);

    emf.dispatchEvent(new Event("ended"));
    expect(emf.paused).toBe(true);

    player.setLocalVolumes({ musicVolume: 1, effectsVolume: 0.4 });
    player.applyState(
      createEmfMusicState(
        emfState,
        "emf-2",
        "gm-1",
        "emf-playing-next",
        1_001,
        1_000,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(audioAt(5).paused).toBe(false);
    expect(audioAt(5).volume).toBe(0.4);
  });

  it("lets two clients use different local volumes for the same playback state", async () => {
    const firstPlayer = createPlayer({ musicVolume: 0.3, effectsVolume: 1 });
    const secondPlayer = createPlayer({ musicVolume: 0.6, effectsVolume: 0.5 });
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    const sharedSnapshot = JSON.stringify(playing);

    firstPlayer.applyState(playing);
    secondPlayer.applyState(playing);
    await vi.advanceTimersByTimeAsync(0);

    expect(audioAt(0).volume).toBe(0.3);
    expect(audioAt(7).volume).toBe(0.6);
    expect(audioAt(0).currentTime).toBe(audioAt(7).currentTime);
    firstPlayer.setLocalVolumes({ musicVolume: 0.2, effectsVolume: 1 });
    expect(audioAt(0).volume).toBe(0.2);
    expect(audioAt(7).volume).toBe(0.6);

    const emfState = createEmfMusicState(
      playing,
      "emf-1",
      "gm-1",
      "shared-emf",
      1_001,
      1_000,
    );
    firstPlayer.applyState(emfState);
    secondPlayer.applyState(emfState);
    await vi.advanceTimersByTimeAsync(0);
    expect(audioAt(4).volume).toBe(1);
    expect(audioAt(11).volume).toBe(0.5);
    firstPlayer.setLocalVolumes({ musicVolume: 0.2, effectsVolume: 0.25 });
    expect(audioAt(4).volume).toBe(0.25);
    expect(audioAt(11).volume).toBe(0.5);
    expect(JSON.stringify(playing)).toBe(sharedSnapshot);
  });

  it("multiplies crossfade envelopes by local music volume", async () => {
    const crossfadePlayer = createPlayer({
      musicVolume: 0.5,
      effectsVolume: 1,
    });
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      1_000,
      1_000,
    );
    crossfadePlayer.applyState(playing);
    crossfadePlayer.applyState(
      createManualMusicState(
        playing,
        { type: "SELECT_TRACK", trackId: "o-idolo" },
        "gm-1",
        "changed",
        1_001,
        1_500,
      ),
    );
    await vi.advanceTimersByTimeAsync(500 + MUSIC_TRACK_CROSSFADE_MS / 2);
    expect(audioAt(0).volume).toBeCloseTo(Math.SQRT1_2 * 0.5, 2);
    expect(audioAt(2).volume).toBeCloseTo(Math.SQRT1_2 * 0.5, 2);
    await vi.advanceTimersByTimeAsync(MUSIC_TRACK_CROSSFADE_MS / 2 + 100);
    expect(audioAt(2).paused).toBe(false);
    expect(audioAt(2).volume).toBe(0.5);
  });

  it("multiplies cinematic handoff envelopes by local music volume", async () => {
    const handoffPlayer = createPlayer({
      musicVolume: 0.5,
      effectsVolume: 0.25,
    });
    const cinematic = createCinematicMusicState(
      "gm-1",
      "cinematic",
      1,
      1_000,
      2_500,
    );
    handoffPlayer.applyState(cinematic);
    const handoff = cinematic.cinematic;
    const outro = handoff?.outro;
    await vi.advanceTimersByTimeAsync(
      (outro?.startAtGm ?? Number.NaN) - Date.now(),
    );
    await vi.advanceTimersByTimeAsync((outro?.durationMs ?? 0) / 2);
    const localGain = audioAt(0).volume;
    handoffPlayer.setLocalVolumes({ musicVolume: 1, effectsVolume: 0.25 });
    expect(audioAt(0).volume).toBeCloseTo(localGain * 2, 9);
    handoffPlayer.setLocalVolumes({ musicVolume: 0.5, effectsVolume: 0.25 });

    await vi.advanceTimersByTimeAsync(
      (handoff?.videoEndsAtGm ?? Number.NaN) - Date.now(),
    );
    handoffPlayer.reconcile(cinematic);
    const gainAtVideoEnd = CINEMATIC_OUTRO_MUSIC.closingGain * 0.5;
    expect(audioAt(0).volume).toBeCloseTo(gainAtVideoEnd, 7);
    const completed = createPostCinematicMusicState(
      cinematic,
      "gm-1",
      "manual-after-cinematic",
      handoff?.videoEndsAtGm ?? Number.NaN,
    );
    handoffPlayer.applyState(completed);
    await vi.advanceTimersByTimeAsync(0);
    expect(audioAt(0).volume).toBeCloseTo(gainAtVideoEnd, 7);
    expect(audioAt(4).volume).toBe(0.25);
  });

  it("keeps the previous track alive through a synchronized crossfade", async () => {
    const player = createPlayer();
    expect(FakeAudio.instances).toHaveLength(7);
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

  it("stops music for an EMF, ends in silence and replays it from zero", async () => {
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

    const music = audioAt(0);
    const emf1 = audioAt(4);
    const first = createEmfMusicState(
      playing,
      "emf-1",
      "gm-1",
      "emf-first",
      1_000,
      1_500,
    );
    player.applyState(first);
    await vi.advanceTimersByTimeAsync(499);
    expect(music.paused).toBe(false);
    expect(emf1.paused).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(music.paused).toBe(true);
    expect(emf1.paused).toBe(false);
    expect(emf1.currentTime).toBe(0);
    expect(emf1.loop).toBe(false);

    emf1.dispatchEvent(new Event("ended"));
    expect(emf1.paused).toBe(true);
    expect(FakeAudio.instances.every((audio) => audio.paused)).toBe(true);

    const replay = createEmfMusicState(
      first,
      "emf-1",
      "gm-1",
      "emf-replay",
      1_500,
      2_000,
    );
    player.applyState(replay);
    await vi.advanceTimersByTimeAsync(500);
    expect(emf1.paused).toBe(false);
    expect(emf1.currentTime).toBe(0);

    vi.setSystemTime(
      (replay.emf?.startAtGm ?? 0) +
        Math.ceil((replay.emf?.durationSeconds ?? 0) * 1_000) +
        1,
    );
    player.reconcile(replay);
    expect(FakeAudio.instances.every((audio) => audio.paused)).toBe(true);
  });

  it("stops the active EMF before starting another EMF", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const emf1State = createEmfMusicState(
      initial,
      "emf-1",
      "gm-1",
      "emf-1-state",
      1_000,
      1_000,
    );
    player.applyState(emf1State);
    await vi.advanceTimersByTimeAsync(0);

    const emf1 = audioAt(4);
    const emf2 = audioAt(5);
    expect(emf1.paused).toBe(false);
    const emf2State = createEmfMusicState(
      emf1State,
      "emf-2",
      "gm-1",
      "emf-2-state",
      1_000,
      1_500,
    );
    player.applyState(emf2State);
    await vi.advanceTimersByTimeAsync(500);

    expect(emf1.paused).toBe(true);
    expect(emf2.paused).toBe(false);
    expect(emf2.currentTime).toBe(0);
    expect(emf2.loop).toBe(false);
  });

  it("stops an EMF and starts a manually selected music track normally", async () => {
    const player = createPlayer();
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const emf = createEmfMusicState(
      initial,
      "emf-3",
      "gm-1",
      "emf-state",
      1_000,
      1_000,
    );
    player.applyState(emf);
    await vi.advanceTimersByTimeAsync(0);

    const emf3 = audioAt(6);
    expect(emf3.paused).toBe(false);
    const selected = createManualMusicState(
      emf,
      { type: "SELECT_TRACK", trackId: "o-idolo" },
      "gm-1",
      "selected-state",
      1_000,
      1_250,
    );
    player.applyState(selected);
    await vi.advanceTimersByTimeAsync(250);

    expect(emf3.paused).toBe(true);
    expect(audioAt(2).paused).toBe(true);

    const music = createManualMusicState(
      selected,
      { type: "PLAY" },
      "gm-1",
      "manual-state",
      1_250,
      1_500,
    );
    player.applyState(music);
    await vi.advanceTimersByTimeAsync(250);

    expect(audioAt(2).paused).toBe(false);
    expect(audioAt(2).volume).toBe(1);
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
      (handoff?.videoEndsAtGm ?? 0) -
        CINEMATIC_OUTRO_MUSIC.terminalGainRampMs -
        Date.now(),
    );
    expect(manualTrack.volume).toBeCloseTo(
      CINEMATIC_OUTRO_MUSIC.targetGain,
      6,
    );

    await vi.advanceTimersByTimeAsync(
      CINEMATIC_OUTRO_MUSIC.terminalGainRampMs / 2,
    );
    player.reconcile(cinematic);
    expect(manualTrack.volume).toBeCloseTo(
      musicGainAtGm(cinematic, Date.now()),
      9,
    );

    await vi.advanceTimersByTimeAsync(
      CINEMATIC_OUTRO_MUSIC.terminalGainRampMs / 2,
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
      CINEMATIC_OUTRO_MUSIC.closingGain,
      7,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(manualTrack.volume).toBeCloseTo(0.39405106, 3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manualTrack.volume).toBeCloseTo(0.640919147, 3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(manualTrack.volume).toBe(1);
    expect(cinematicTrack.paused).toBe(true);
    expect(audioAt(3).paused).toBe(true);
  });

  it("alternates two compressed voices across two scheduled seams", async () => {
    const player = createPlayer({ musicVolume: 0.5, effectsVolume: 1 });
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
    expect(voiceA.volume).toBeCloseTo(0.5, 6);
    expect(voiceB.volume).toBeCloseTo(0, 6);

    await vi.advanceTimersByTimeAsync(160);
    expect(voiceA.volume).toBeGreaterThan(0.325);
    expect(voiceA.volume).toBeLessThan(0.375);
    expect(voiceB.volume).toBeGreaterThan(0.325);
    expect(voiceB.volume).toBeLessThan(0.375);

    await vi.advanceTimersByTimeAsync(
      MUSIC_LOOP_CROSSFADE_MS - 160 + MUSIC_GAIN_STEP_MS,
    );
    expect(voiceA.paused).toBe(true);
    expect(voiceB.paused).toBe(false);
    expect(voiceB.volume).toBe(0.5);

    await vi.advanceTimersByTimeAsync(
      cycleSeconds * 1_000 - MUSIC_LOOP_CROSSFADE_MS,
    );
    expect(voiceA.paused).toBe(false);
    expect(voiceB.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(MUSIC_LOOP_CROSSFADE_MS);
    expect(voiceA.paused).toBe(false);
    expect(voiceA.volume).toBe(0.5);
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
