import { EXTENSION_ID } from "./config";

export interface LocalAudioVolumes {
  musicVolume: number;
  effectsVolume: number;
}

export const DEFAULT_LOCAL_AUDIO_VOLUMES: Readonly<LocalAudioVolumes> = {
  musicVolume: 1,
  effectsVolume: 1,
};

const LOCAL_AUDIO_STORAGE_PREFIX = `${EXTENSION_ID}/local-audio-volumes/`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function clampLocalVolume(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

export function normalizeLocalAudioVolumes(value: unknown): LocalAudioVolumes {
  return {
    musicVolume: clampLocalVolume(
      isRecord(value) ? value.musicVolume : undefined,
    ),
    effectsVolume: clampLocalVolume(
      isRecord(value) ? value.effectsVolume : undefined,
    ),
  };
}

export function localAudioStorageKey(playerId: string): string {
  return `${LOCAL_AUDIO_STORAGE_PREFIX}${encodeURIComponent(playerId)}`;
}

export function parseLocalAudioVolumes(serialized: string | null): LocalAudioVolumes {
  if (serialized === null) {
    return { ...DEFAULT_LOCAL_AUDIO_VOLUMES };
  }
  try {
    return normalizeLocalAudioVolumes(JSON.parse(serialized));
  } catch {
    return { ...DEFAULT_LOCAL_AUDIO_VOLUMES };
  }
}

export function loadLocalAudioVolumes(
  storage: Storage,
  playerId: string,
): LocalAudioVolumes {
  try {
    return parseLocalAudioVolumes(storage.getItem(localAudioStorageKey(playerId)));
  } catch {
    return { ...DEFAULT_LOCAL_AUDIO_VOLUMES };
  }
}

export function saveLocalAudioVolumes(
  storage: Storage,
  playerId: string,
  volumes: LocalAudioVolumes,
): LocalAudioVolumes {
  const normalized = normalizeLocalAudioVolumes(volumes);
  storage.setItem(localAudioStorageKey(playerId), JSON.stringify(normalized));
  return normalized;
}
