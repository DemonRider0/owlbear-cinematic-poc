import { describe, expect, it } from "vitest";
import {
  CINEMATIC_AUDIO_FADE_OUT_MS,
  CINEMATIC_AUDIO_SILENT_TAIL_MS,
  CINEMATIC_OUTRO_MUSIC,
  CINEMATIC_MUSIC_SYNC,
  cinematicAudioGainForRemainingMs,
} from "../src/config";

describe("terminal cinematic audio envelope", () => {
  it("reaches zero before EOF and remains silent through ended", () => {
    const fadeStartsAtRemainingMs =
      CINEMATIC_AUDIO_FADE_OUT_MS + CINEMATIC_AUDIO_SILENT_TAIL_MS;

    expect(cinematicAudioGainForRemainingMs(fadeStartsAtRemainingMs)).toBe(1);
    expect(
      cinematicAudioGainForRemainingMs(
        CINEMATIC_AUDIO_SILENT_TAIL_MS + CINEMATIC_AUDIO_FADE_OUT_MS / 2,
      ),
    ).toBeCloseTo(Math.SQRT1_2, 9);
    expect(
      cinematicAudioGainForRemainingMs(CINEMATIC_AUDIO_SILENT_TAIL_MS),
    ).toBe(0);
    expect(
      cinematicAudioGainForRemainingMs(CINEMATIC_AUDIO_SILENT_TAIL_MS / 2),
    ).toBe(0);
    expect(cinematicAudioGainForRemainingMs(0)).toBe(0);
  });

  it("keeps O Porão audible throughout the silent MP4 tail", () => {
    const silentTailStartsAtVideoSeconds =
      CINEMATIC_MUSIC_SYNC.videoDurationSeconds -
      CINEMATIC_AUDIO_SILENT_TAIL_MS / 1_000;
    const outroFadeEndsAtVideoSeconds =
      CINEMATIC_OUTRO_MUSIC.startsAtVideoSeconds +
      CINEMATIC_OUTRO_MUSIC.durationMs / 1_000;

    expect(outroFadeEndsAtVideoSeconds).toBeLessThan(
      silentTailStartsAtVideoSeconds,
    );
    expect(CINEMATIC_OUTRO_MUSIC.targetGain).toBe(0.251188643);
    expect(CINEMATIC_OUTRO_MUSIC.normalizationMs).toBe(4_000);
  });
});
