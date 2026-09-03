import { describe, expect, it } from "vitest";
import {
  calculateClockSample,
  calculateLocalStartAt,
} from "../src/clock-sync";

describe("clock synchronization", () => {
  it("estimates the GM-to-client offset from the round-trip midpoint", () => {
    const sample = calculateClockSample(1_000, 1_100, 1_250);

    expect(sample.roundTripMs).toBe(100);
    expect(sample.offsetGmMinusLocalMs).toBe(200);
  });

  it("converts a GM timestamp into the local clock domain", () => {
    expect(calculateLocalStartAt(5_000, 3_500, 10_000, 200)).toBe(4_800);
  });

  it("falls back to the protocol margin without assuming equal clocks", () => {
    expect(calculateLocalStartAt(5_000, 3_500, 20_000)).toBe(21_500);
  });
});
