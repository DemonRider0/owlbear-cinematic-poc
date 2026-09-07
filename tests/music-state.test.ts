import { describe, expect, it } from "vitest";
import {
  CINEMATIC_OUTRO_MUSIC,
  CINEMATIC_MUSIC_SYNC,
  MUSIC_LOOP_CROSSFADE_MS,
  MUSIC_TRACK_CROSSFADE_MS,
  getMusicLoopCycleSeconds,
} from "../src/config";
import {
  createAuthorityTakeoverMusicState,
  createCinematicMusicState,
  createInitialMusicState,
  createManualMusicState,
  createPostCinematicMusicState,
  isMusicState,
  musicGainAtGm,
  musicPositionAtGm,
  nextMusicLoopSeamAtGm,
} from "../src/music-state";

describe("music state anchors", () => {
  it("derives playback position without periodic broadcasts", () => {
    const initial = createInitialMusicState("gm-1", "initial", 1_000);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      2_000,
      2_500,
    );

    expect(musicPositionAtGm(playing, 12_500)).toBeCloseTo(10, 6);
  });

  it("schedules the dual-voice seam on the explicit logical cycle", () => {
    const cycleSeconds = getMusicLoopCycleSeconds("o-porao");
    expect(cycleSeconds).toBeCloseTo(314.560479167, 9);
    expect(MUSIC_LOOP_CROSSFADE_MS).toBe(300);
    expect(
      nextMusicLoopSeamAtGm(
        "o-porao",
        cycleSeconds - 1.25,
        10_000,
      ),
    ).toBe(11_250);
    expect(nextMusicLoopSeamAtGm("o-porao", 0, 10_000)).toBeCloseTo(
      10_000 + cycleSeconds * 1_000,
      6,
    );
  });

  it("anchors pause and seek at their synchronized application time", () => {
    const initial = createInitialMusicState("gm-1", "initial", 0);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      100,
      500,
    );
    const paused = createManualMusicState(
      playing,
      { type: "PAUSE" },
      "gm-1",
      "paused",
      4_000,
      4_500,
    );
    const seeked = createManualMusicState(
      paused,
      { type: "SEEK", positionSeconds: 92.25 },
      "gm-1",
      "seeked",
      5_000,
      5_500,
    );

    expect(paused.playing).toBe(false);
    expect(paused.positionSeconds).toBeCloseTo(4, 6);
    expect(musicPositionAtGm(paused, 50_000)).toBeCloseTo(4, 6);
    expect(seeked.positionSeconds).toBe(92.25);
  });

  it("describes an anchored equal-power crossfade on track selection", () => {
    const initial = createInitialMusicState("gm-1", "initial", 0);
    const playing = createManualMusicState(
      initial,
      { type: "PLAY" },
      "gm-1",
      "playing",
      100,
      500,
    );
    const changed = createManualMusicState(
      playing,
      { type: "SELECT_TRACK", trackId: "o-idolo" },
      "gm-1",
      "changed",
      4_000,
      4_500,
    );

    expect(changed.trackId).toBe("o-idolo");
    expect(changed.positionSeconds).toBe(0);
    expect(changed.transition).toEqual({
      kind: "TRACK_CROSSFADE",
      fromTrackId: "o-porao",
      fromPositionSeconds: 4,
      startAtGm: 4_500,
      durationMs: MUSIC_TRACK_CROSSFADE_MS,
    });
  });

  it("describes the direct cinematic-to-O Porão handoff", () => {
    const state = createCinematicMusicState(
      "gm-1",
      "cinematic-1",
      7,
      10_000,
      11_500,
    );

    expect(state.trackId).toBe(CINEMATIC_MUSIC_SYNC.trackId);
    expect(state.positionSeconds).toBe(
      CINEMATIC_MUSIC_SYNC.playerPositionAtVideoStartSeconds,
    );
    expect(state.cinematic?.audibleAtGm).toBe(
      11_500 +
        CINEMATIC_MUSIC_SYNC.externalOverlapStartsAtVideoSeconds * 1_000,
    );
    expect(
      musicPositionAtGm(
        state,
        state.cinematic?.embeddedMusicEndsAtGm ?? Number.NaN,
      ),
    ).toBeCloseTo(CINEMATIC_MUSIC_SYNC.playerPositionAtHandoffSeconds, 6);
    expect(state.cinematic?.outro).toEqual({
      trackId: CINEMATIC_OUTRO_MUSIC.trackId,
      positionSeconds: CINEMATIC_OUTRO_MUSIC.positionSeconds,
      startAtGm:
        11_500 + CINEMATIC_OUTRO_MUSIC.startsAtVideoSeconds * 1_000,
      durationMs: CINEMATIC_OUTRO_MUSIC.durationMs,
      targetGain: CINEMATIC_OUTRO_MUSIC.targetGain,
      normalizationMs: CINEMATIC_OUTRO_MUSIC.normalizationMs,
      fromPositionSeconds:
        CINEMATIC_OUTRO_MUSIC.sourceTrackPositionAtStartSeconds,
    });
    expect(
      CINEMATIC_OUTRO_MUSIC.startsAtVideoSeconds +
        CINEMATIC_OUTRO_MUSIC.durationMs / 1_000,
    ).toBeCloseTo(33.835940079, 6);
    expect(isMusicState(state)).toBe(true);
  });

  it("materializes O Porão as a playing manual state at video end", () => {
    const cinematic = createCinematicMusicState(
      "gm-1",
      "cinematic-1",
      7,
      10_000,
      11_500,
    );
    const completed = createPostCinematicMusicState(
      cinematic,
      "gm-1",
      "manual-1",
      cinematic.cinematic?.videoEndsAtGm ?? Number.NaN,
    );

    expect(completed.mode).toBe("MANUAL");
    expect(completed.trackId).toBe("o-porao");
    expect(completed.playing).toBe(true);
    expect(completed.anchorAtGm).toBe(cinematic.cinematic?.videoEndsAtGm);
    expect(completed.positionSeconds).toBeCloseTo(36.25, 6);
    expect(completed.gainTransition).toEqual({
      startAtGm: cinematic.cinematic?.videoEndsAtGm,
      endAtGm:
        (cinematic.cinematic?.videoEndsAtGm ?? Number.NaN) + 4_000,
      fromGain: CINEMATIC_OUTRO_MUSIC.targetGain,
      toGain: 1,
    });
    expect(musicGainAtGm(completed, completed.anchorAtGm)).toBeCloseTo(
      0.251188643,
      9,
    );
    expect(musicGainAtGm(completed, completed.anchorAtGm + 1_000)).toBeCloseTo(
      0.368190418,
      9,
    );
    expect(musicGainAtGm(completed, completed.anchorAtGm + 2_000)).toBeCloseTo(
      0.625594322,
      8,
    );
    expect(musicGainAtGm(completed, completed.anchorAtGm + 3_000)).toBeCloseTo(
      0.882998225,
      9,
    );
    expect(musicGainAtGm(completed, completed.anchorAtGm + 4_000)).toBe(1);
    expect(musicPositionAtGm(completed, completed.anchorAtGm + 5_000)).toBeCloseTo(
      41.25,
      6,
    );
    expect(isMusicState(completed)).toBe(true);
  });

  it("preserves and reanchors the cinematic agenda on authority takeover", () => {
    const cinematic = createCinematicMusicState(
      "gm-old",
      "cinematic-1",
      7,
      10_000,
      11_500,
    );
    const previousNow = 21_500;
    const newNow = 19_250;
    const takeover = createAuthorityTakeoverMusicState(
      cinematic,
      "gm-new",
      "takeover-1",
      previousNow,
      newNow,
    );

    expect(takeover.mode).toBe("CINEMATIC");
    expect(takeover.authorityConnectionId).toBe("gm-new");
    expect(takeover.anchorAtGm).toBe(cinematic.anchorAtGm - 2_250);
    expect(takeover.cinematic?.videoStartAtGm).toBe(9_250);
    expect(takeover.cinematic?.audibleAtGm).toBe(
      (cinematic.cinematic?.audibleAtGm ?? Number.NaN) - 2_250,
    );
    expect(takeover.cinematic?.outro?.startAtGm).toBe(
      (cinematic.cinematic?.outro?.startAtGm ?? Number.NaN) - 2_250,
    );
    expect(takeover.cinematic?.videoEndsAtGm).toBe(
      (cinematic.cinematic?.videoEndsAtGm ?? Number.NaN) - 2_250,
    );
    expect(isMusicState(takeover)).toBe(true);
  });

  it("materializes the advanced O Porão position on a late takeover", () => {
    const cinematic = createCinematicMusicState(
      "gm-old",
      "cinematic-1",
      7,
      10_000,
      11_500,
    );
    const videoEndsAtGm = cinematic.cinematic?.videoEndsAtGm ?? Number.NaN;
    const takeover = createAuthorityTakeoverMusicState(
      cinematic,
      "gm-new",
      "takeover-1",
      videoEndsAtGm + 5_000,
      90_000,
    );

    expect(takeover.mode).toBe("MANUAL");
    expect(takeover.trackId).toBe("o-porao");
    expect(takeover.playing).toBe(true);
    expect(takeover.positionSeconds).toBeCloseTo(41.25, 6);
    expect(takeover.anchorAtGm).toBe(90_000);
    expect(takeover.cinematic).toBeUndefined();
    expect(isMusicState(takeover)).toBe(true);
  });
});
