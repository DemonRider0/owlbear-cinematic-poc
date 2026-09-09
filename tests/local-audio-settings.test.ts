import { describe, expect, it } from "vitest";
import {
  loadLocalAudioVolumes,
  normalizeLocalAudioVolumes,
  saveLocalAudioVolumes,
} from "../src/local-audio-settings";

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

describe("local audio settings", () => {
  it("defaults missing saved volumes to 100%", () => {
    expect(loadLocalAudioVolumes(new MemoryStorage(), "player-a")).toEqual({
      musicVolume: 1,
      effectsVolume: 1,
    });
  });

  it("survives reload and isolates preferences by player ID", () => {
    const storage = new MemoryStorage();
    saveLocalAudioVolumes(storage, "gm", {
      musicVolume: 0.3,
      effectsVolume: 0.4,
    });
    saveLocalAudioVolumes(storage, "player-a", {
      musicVolume: 1,
      effectsVolume: 0.8,
    });
    saveLocalAudioVolumes(storage, "player-b", {
      musicVolume: 0.6,
      effectsVolume: 0.2,
    });

    expect(loadLocalAudioVolumes(storage, "gm")).toEqual({
      musicVolume: 0.3,
      effectsVolume: 0.4,
    });
    expect(loadLocalAudioVolumes(storage, "player-a")).toEqual({
      musicVolume: 1,
      effectsVolume: 0.8,
    });
    expect(loadLocalAudioVolumes(storage, "player-b")).toEqual({
      musicVolume: 0.6,
      effectsVolume: 0.2,
    });
  });

  it("clamps invalid persisted ranges without producing NaN", () => {
    const storage = new MemoryStorage();
    saveLocalAudioVolumes(storage, "player-a", {
      musicVolume: -2,
      effectsVolume: 4,
    });

    expect(loadLocalAudioVolumes(storage, "player-a")).toEqual({
      musicVolume: 0,
      effectsVolume: 1,
    });

    expect(
      normalizeLocalAudioVolumes({
        musicVolume: Number.NaN,
        effectsVolume: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      musicVolume: 1,
      effectsVolume: 1,
    });
  });
});
