import { describe, expect, it } from "vitest";
import {
  canTransition,
  isReadyForPlayback,
  transition,
} from "../src/state-machine";

describe("client state machine", () => {
  it("accepts the complete successful lifecycle", () => {
    let phase = transition("LOADING", "READY");
    phase = transition(phase, "ARMED");
    phase = transition(phase, "FADING_IN");
    phase = transition(phase, "PLAYING");
    phase = transition(phase, "FADING_OUT");
    phase = transition(phase, "IDLE");

    expect(phase).toBe("IDLE");
    expect(isReadyForPlayback(phase)).toBe(true);
  });

  it("rejects impossible combinations", () => {
    expect(canTransition("LOADING", "PLAYING")).toBe(false);
    expect(() => transition("READY", "FADING_OUT")).toThrow(
      "Invalid client phase transition",
    );
  });

  it("allows errors to be retried only through loading", () => {
    expect(transition("LOADING", "ERROR")).toBe("ERROR");
    expect(transition("ERROR", "LOADING")).toBe("LOADING");
    expect(canTransition("ERROR", "READY")).toBe(false);
  });
});
