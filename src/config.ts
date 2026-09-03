export const EXTENSION_ID = "dev.cinematic-sync.poc";

// Relative to each built HTML entry so local development and a GitHub Pages
// project subpath resolve to the same asset.
export const CINEMATIC_URL = "./assets/cinematic.mp4";
export const CINEMATIC_CACHE_VERSION = "poc-1";
export const CINEMATIC_CACHE_PREFIX = `${EXTENSION_ID}/media/`;
export const CINEMATIC_CACHE_NAME =
  `${CINEMATIC_CACHE_PREFIX}${CINEMATIC_CACHE_VERSION}`;

export const PROTOCOL_VERSION = 1;
export const BROADCAST_CHANNEL = `${EXTENSION_ID}/protocol/v${PROTOCOL_VERSION}`;

export const TOOL_ID = `${EXTENSION_ID}/tool`;
export const CONTROL_POPOVER_ID = `${EXTENSION_ID}/controls`;
export const CINEMATIC_MODAL_ID = `${EXTENSION_ID}/cinematic`;

export const PLAY_START_DELAY_MS = 1_500;
export const FADE_IN_MS = 600;
export const FADE_OUT_MS = 700;
export const PRELOAD_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const MEDIA_PROBE_TIMEOUT_MS = 30_000;
export const MODAL_PREPARE_TIMEOUT_MS = 30_000;
export const PLAYBACK_WATCHDOG_GRACE_MS = 15_000;
export const MODAL_CLOSE_RETRY_MS = 250;

export const CLOCK_SYNC_SAMPLE_COUNT = 3;
export const CLOCK_SYNC_SAMPLE_INTERVAL_MS = 300;
export const STATUS_REFRESH_INTERVAL_MS = 5_000;

export function resolveAppUrl(relativeUrl: string): string {
  return new URL(relativeUrl, window.location.href).href;
}

export function getCinematicRequestUrl(): string {
  const url = new URL(CINEMATIC_URL, window.location.href);
  url.searchParams.set("cinematic-cache", CINEMATIC_CACHE_VERSION);
  return url.href;
}
