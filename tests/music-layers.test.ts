import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getMusicLoop, getMusicTrackConfig, MUSIC_TRACKS, type MusicTrackId } from "../src/config";
import {
  compareMusicStates,
  createAuthorityTakeoverMusicState,
  createCinematicMusicState,
  createEmfMusicState,
  createInitialMusicState,
  createLayeredMusicState,
  createManualMusicState,
  createPostCinematicMusicState,
  getMusicLayer,
  getMusicMixVolume,
  isMusicControlAction,
  isMusicState,
  musicLayerFadeAtGm,
  musicLayerMixAtGm,
  musicLayerPositionAtGm,
  musicLayerStatusAtGm,
  type LayerMusicControlAction,
  type MusicState,
} from "../src/music-state";

const gm = "gm";
const vali = "vali-et-ensomt-minne";
const wildfire = "wildfire";
const nightfire = "nightfire-ritual";
const whatRemains = "what-remains";

function initial(): MusicState {
  return createInitialMusicState(gm, "initial", 500);
}

function command(state: MusicState, action: LayerMusicControlAction, at: number): MusicState {
  return createLayeredMusicState(state, action, gm, String(state.revision + 1), at - 500, at);
}

function layer(state: MusicState, id: MusicTrackId) {
  const result = getMusicLayer(state, id);
  if (!result) throw new Error(`Faixa ausente: ${id}`);
  return result;
}

describe("synchronized music layers", () => {
  it("migrates an old playing snapshot on the first layered command", () => {
    const old = createManualMusicState(initial(), { type: "PLAY" }, gm, "old", 700, 1_000);
    expect(isMusicState(old)).toBe(true);
    const migrated = command(old, { type: "ADD_TRACK", trackId: vali }, 5_000);
    expect(isMusicState(JSON.parse(JSON.stringify(migrated)))).toBe(true);
    expect(migrated.schemaVersion).toBe(2);
    expect(musicLayerPositionAtGm(layer(migrated, "o-porao"), 7_000)).toBe(6);
    expect(musicLayerPositionAtGm(layer(migrated, vali), 7_000)).toBe(2);
    expect(getMusicMixVolume(migrated, "o-porao")).toBe(1);
  });

  it("adds independent anchors and keeps duplicate Add idempotent", () => {
    const first = command(initial(), { type: "ADD_TRACK", trackId: vali }, 1_000);
    const second = command(first, { type: "ADD_TRACK", trackId: wildfire }, 3_000);
    const third = command(second, { type: "ADD_TRACK", trackId: nightfire }, 4_000);
    expect(layer(third, vali)).toEqual(layer(first, vali));
    expect(layer(third, wildfire)).toEqual(layer(second, wildfire));
    expect(musicLayerPositionAtGm(layer(third, vali), 7_000)).toBe(6);
    expect(musicLayerPositionAtGm(layer(third, wildfire), 7_000)).toBe(4);
    expect(musicLayerPositionAtGm(layer(third, nightfire), 7_000)).toBe(3);
    expect(command(third, { type: "ADD_TRACK", trackId: nightfire }, 8_000)).toBe(third);
  });

  it("replaces all layers with one anchored fade while preserving the selected position", () => {
    let state = command(initial(), { type: "ADD_TRACK", trackId: vali }, 1_000);
    state = command(state, { type: "ADD_TRACK", trackId: wildfire }, 2_000);
    state = command(state, { type: "ADD_TRACK", trackId: nightfire }, 3_000);
    const replacement = command(state, { type: "REPLACE_TRACK", trackId: wildfire }, 6_000);
    expect(layer(replacement, wildfire)).toEqual(layer(state, wildfire));
    expect(musicLayerFadeAtGm(layer(replacement, vali), 8_000)).toBeCloseTo(Math.SQRT1_2);
    expect(musicLayerStatusAtGm(layer(replacement, nightfire), 10_000)).toBe("STOPPED");
    expect(musicLayerPositionAtGm(layer(replacement, wildfire), 10_000)).toBe(8);

    const next = command(replacement, { type: "REPLACE_TRACK", trackId: whatRemains }, 6_100);
    expect(musicLayerPositionAtGm(layer(next, whatRemains), 6_100)).toBe(0);
    expect(musicLayerFadeAtGm(layer(next, whatRemains), 8_100)).toBeCloseTo(Math.SQRT1_2);
    expect(musicLayerStatusAtGm(layer(next, wildfire), 10_100)).toBe("STOPPED");
  });

  it("preserves the first intro, wraps every cycle and resumes a paused layer independently", () => {
    const startAt = 1_000;
    const loop = getMusicLoop(whatRemains);
    let state = command(initial(), { type: "PLAY_LAYER", trackId: whatRemains }, startAt);
    state = command(state, { type: "PLAY_LAYER", trackId: vali }, 2_000);
    const firstSeam = startAt + loop.seamSeconds * 1_000;
    expect(musicLayerPositionAtGm(layer(state, whatRemains), 6_000)).toBe(5);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const at = firstSeam + cycle * loop.cycleSeconds * 1_000 + 150;
      expect(musicLayerPositionAtGm(layer(state, whatRemains), at)).toBeCloseTo(loop.startSeconds + 0.15);
    }
    state = command(state, { type: "PAUSE_LAYER", trackId: whatRemains }, firstSeam + 200);
    expect(musicLayerStatusAtGm(layer(state, whatRemains), firstSeam + 800)).toBe("PAUSING");
    expect(musicLayerPositionAtGm(layer(state, whatRemains), firstSeam + 800)).toBeCloseTo(loop.startSeconds + 0.8);
    expect(musicLayerStatusAtGm(layer(state, whatRemains), firstSeam + 4_200)).toBe("PAUSED");
    expect(musicLayerPositionAtGm(layer(state, whatRemains), firstSeam + 5_000)).toBeCloseTo(loop.startSeconds + 4.2);
    expect(musicLayerStatusAtGm(layer(state, vali), firstSeam + 800)).toBe("PLAYING");
    state = command(state, { type: "PLAY_LAYER", trackId: whatRemains }, firstSeam + 5_000);
    expect(layer(state, whatRemains).positionSeconds).toBeGreaterThan(loop.seamSeconds);
    expect(musicLayerPositionAtGm(layer(state, whatRemains), firstSeam + 6_000)).toBeCloseTo(loop.startSeconds + 5.2);
    state = command(state, { type: "SEEK_LAYER", trackId: whatRemains, positionSeconds: 3 }, firstSeam + 7_000);
    expect(musicLayerPositionAtGm(layer(state, whatRemains), firstSeam + 8_000)).toBe(4);
    state = command(state, { type: "STOP_LAYER", trackId: whatRemains }, firstSeam + 8_000);
    expect(musicLayerStatusAtGm(layer(state, whatRemains), firstSeam + 9_000)).toBe("STOPPED");
    expect(musicLayerPositionAtGm(layer(state, whatRemains), firstSeam + 9_000)).toBe(0);
  });

  it("supersedes a pause with Play, Stop or Replace without reusing an old fade deadline", () => {
    let state = command(initial(), { type: "ADD_TRACK", trackId: wildfire }, 1_000);
    state = command(state, { type: "ADD_TRACK", trackId: nightfire }, 2_000);
    const pausing = command(state, { type: "PAUSE_LAYER", trackId: wildfire }, 3_000);
    const fading = layer(pausing, wildfire);
    expect(isMusicState(JSON.parse(JSON.stringify(pausing)))).toBe(true);
    expect(isMusicState({ ...pausing, layers: [layer(pausing, nightfire), { ...fading, fade: undefined }] })).toBe(false);
    expect(command(pausing, { type: "PAUSE_LAYER", trackId: wildfire }, 3_500)).toBe(pausing);

    const resumed = command(pausing, { type: "PLAY_LAYER", trackId: wildfire }, 4_000);
    expect(layer(resumed, wildfire).anchorAtGm).toBe(layer(state, wildfire).anchorAtGm);
    expect(musicLayerFadeAtGm(layer(resumed, wildfire), 4_000)).toBeCloseTo(musicLayerFadeAtGm(fading, 4_000));
    expect(musicLayerStatusAtGm(layer(resumed, wildfire), 7_001)).toBe("PLAYING");
    expect(layer(resumed, nightfire)).toEqual(layer(state, nightfire));

    const stopped = command(pausing, { type: "STOP_LAYER", trackId: wildfire }, 4_000);
    expect(musicLayerStatusAtGm(layer(stopped, wildfire), 4_350)).toBe("STOPPED");
    const replacement = command(pausing, { type: "REPLACE_TRACK", trackId: nightfire }, 4_000);
    expect(musicLayerStatusAtGm(layer(replacement, wildfire), 7_001)).toBe("STOPPING");
    expect(musicLayerStatusAtGm(layer(replacement, wildfire), 8_000)).toBe("STOPPED");
    expect(layer(replacement, nightfire)).toEqual(layer(state, nightfire));
    const kept = command(pausing, { type: "REPLACE_TRACK", trackId: wildfire }, 4_000);
    expect(musicLayerPositionAtGm(layer(kept, wildfire), 4_000)).toBe(3);
  });

  it("keeps a pause deadline during seek and freezes that position after takeover", () => {
    const state = command(initial(), { type: "ADD_TRACK", trackId: "tensao-ruptura" }, 1_000);
    const pausing = command(state, { type: "PAUSE_LAYER", trackId: "tensao-ruptura" }, 3_000);
    const seek = command(pausing, { type: "SEEK_LAYER", trackId: "tensao-ruptura", positionSeconds: 20 }, 5_000);
    expect(musicLayerStatusAtGm(layer(seek, "tensao-ruptura"), 6_000)).toBe("PAUSING");
    expect(musicLayerPositionAtGm(layer(seek, "tensao-ruptura"), 6_000)).toBe(21);
    expect(musicLayerPositionAtGm(layer(seek, "tensao-ruptura"), 8_000)).toBe(22);
    const takeover = createAuthorityTakeoverMusicState(seek, "new-gm", "takeover", 6_000, 20_000);
    expect(isMusicState(takeover)).toBe(true);
    expect(musicLayerPositionAtGm(layer(takeover, "tensao-ruptura"), 20_000)).toBe(21);
    expect(musicLayerPositionAtGm(layer(takeover, "tensao-ruptura"), 30_000)).toBe(22);
  });

  it("keeps per-track ramps independent and preserves EMF exclusivity and cinematic gains", () => {
    let state = command(initial(), { type: "ADD_TRACK", trackId: wildfire }, 1_000);
    state = command(state, { type: "ADD_TRACK", trackId: nightfire }, 2_000);
    state = command(state, { type: "SET_MIX_VOLUME", trackId: nightfire, volume: 0.3 }, 4_000);
    expect(layer(state, nightfire).anchorAtGm).toBe(2_000);
    expect(musicLayerMixAtGm(state, layer(state, nightfire), 4_100)).toBeCloseTo(0.65);
    expect(musicLayerMixAtGm(state, layer(state, wildfire), 4_100)).toBe(1);
    const emf = createEmfMusicState(state, "emf-2", gm, "emf", 5_000, 5_500);
    expect(isMusicState(emf)).toBe(true);
    expect(emf.layers?.every(({ status }) => status !== "PLAYING")).toBe(true);
    const adjusted = command(emf, { type: "SET_MIX_VOLUME", trackId: "o-porao", volume: 0.4 }, 6_000);
    expect(adjusted.emf).toEqual(emf.emf);
    expect(adjusted.mode).toBe("EMF");
    const cinematic = createCinematicMusicState(gm, "cinema", 10, 7_000, 8_500, adjusted.mixVolumes);
    const after = createPostCinematicMusicState(cinematic, gm, "after", 50_000);
    expect(cinematic.gainTransition?.toGain).toBe(0.281838293);
    expect(after.gainTransition?.fromGain).toBe(cinematic.gainTransition?.toGain);
    expect(after.gainTransition?.toGain).toBe(0.4);
    expect(getMusicMixVolume(after, nightfire)).toBe(0.3);
    expect(isMusicState(after)).toBe(true);
  });

  it("validates unique catalog entries and reanchors late or reconnected clients", () => {
    let state = command(initial(), { type: "ADD_TRACK", trackId: vali }, 1_000);
    state = command(state, { type: "ADD_TRACK", trackId: wildfire }, 2_000);
    state = command(state, { type: "SET_MIX_VOLUME", trackId: wildfire, volume: 0.8 }, 3_000);
    const parsed = JSON.parse(JSON.stringify(state)) as MusicState;
    expect(isMusicState(parsed)).toBe(true);
    expect(isMusicState({ ...parsed, layers: [layer(parsed, vali), layer(parsed, vali)] })).toBe(false);
    expect(isMusicState({ ...parsed, mixVolumes: { [wildfire]: 1.1 } })).toBe(false);
    expect(isMusicControlAction({ type: "SET_MIX_VOLUME", trackId: wildfire, volume: Number.NaN })).toBe(false);
    expect(isMusicControlAction({ type: "ADD_TRACK", trackId: "inexistente" })).toBe(false);
    const reconnected = createAuthorityTakeoverMusicState(parsed, "other-gm", "takeover", 240_000, 290_000);
    expect(isMusicState(reconnected)).toBe(true);
    expect(compareMusicStates(reconnected, parsed)).toBeGreaterThan(0);
    expect(compareMusicStates({ ...parsed, revision: 0, updatedAtGm: 99_999 }, parsed)).toBeLessThan(0);
    for (const id of [vali, wildfire] as const) {
      expect(musicLayerPositionAtGm(layer(reconnected, id), 290_000))
        .toBeCloseTo(musicLayerPositionAtGm(layer(parsed, id), 240_000));
    }
    expect(layer(reconnected, wildfire).mixTransition?.startAtGm).toBe(53_000);
  });
});

const newTracks = [
  ["tensao-pressagio", 63.370, 34.230, 0.220],
  ["tensao-crescente", 70.720, 47.350, 0.240],
  ["tensao-ruptura", 40.570, 22.980, 0.240],
  ["perseguicao-frenetica", 18.640, 10.900, 0.140],
] as const;

describe("layered music assets", () => {
  it("has a unique ID for each of the ten tracks", () => {
    expect(new Set(MUSIC_TRACKS.map(({ id }) => id)).size).toBe(10);
    let state = initial();
    for (const [index, [trackId]] of newTracks.entries()) {
      state = command(state, { type: "ADD_TRACK", trackId }, 1_000 + index * 1_000);
    }
    expect(newTracks.every(([id]) => musicLayerStatusAtGm(layer(state, id), 6_000) === "PLAYING")).toBe(true);
    const replaced = command(state, { type: "REPLACE_TRACK", trackId: "tensao-crescente" }, 6_000);
    expect(replaced.layers?.filter((entry) => musicLayerStatusAtGm(entry, 10_000) === "PLAYING")
      .map(({ trackId }) => trackId)).toEqual(["tensao-crescente"]);
  });

  const assets = [...newTracks, ["nightfire-ritual", 177.970, 59.290, 0.280] as const];

  it.each(assets)("matches the Vorbis duration and loop for %s", (id, duration, start, overlap) => {
    const config = getMusicTrackConfig(id);
    const ogg = readFileSync(new URL(`../public/assets/music/${id}.ogg`, import.meta.url));
    const identification = 27 + ogg[26]!;
    expect(ogg.toString("ascii", identification + 1, identification + 7)).toBe("vorbis");
    const sampleRate = ogg.readUInt32LE(identification + 12);
    let offset = 0;
    let samples = 0;
    while (offset < ogg.length) {
      expect(ogg.toString("ascii", offset, offset + 4)).toBe("OggS");
      samples = Number(ogg.readBigInt64LE(offset + 6));
      const segments = ogg[offset + 26]!;
      const payload = ogg.subarray(offset + 27, offset + 27 + segments);
      offset += 27 + segments + payload.reduce((sum, length) => sum + length, 0);
    }
    expect(samples / sampleRate).toBeCloseTo(config.durationSeconds, 6);
    const loop = getMusicLoop(id);
    expect(loop).toMatchObject({ startSeconds: start, endSeconds: duration, crossfadeSeconds: overlap });
    expect(loop.startSeconds).toBeGreaterThanOrEqual(0);
    expect(loop.cycleSeconds).toBeGreaterThan(loop.crossfadeSeconds);
    expect(loop.endSeconds).toBeLessThanOrEqual(config.durationSeconds);
    const state = command(initial(), { type: "ADD_TRACK", trackId: id }, 1_000);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const gmTime = 1_000 + (loop.seamSeconds + cycle * loop.cycleSeconds + 0.05) * 1_000;
      expect(musicLayerPositionAtGm(layer(state, id), gmTime)).toBeCloseTo(start + 0.05, 6);
    }
  });
});
