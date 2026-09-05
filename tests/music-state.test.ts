import { describe, expect, it } from "vitest";
import {
  CINEMATIC_MUSIC_SYNC,
  MUSIC_TRACK_CROSSFADE_MS,
} from "../src/config";
import {
  createCinematicMusicState,
  createInitialMusicState,
  createManualMusicState,
  isMusicState,
  musicPositionAtGm,
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

  it("keeps the cinematic soundtrack on the proven timeline", () => {
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
      11_500 + CINEMATIC_MUSIC_SYNC.embeddedMusicEndsAtVideoSeconds * 1_000,
    );
    expect(
      musicPositionAtGm(
        state,
        state.cinematic?.audibleAtGm ?? Number.NaN,
      ),
    ).toBeCloseTo(CINEMATIC_MUSIC_SYNC.playerPositionAtHandoffSeconds, 6);
    expect(isMusicState(state)).toBe(true);
  });
});
