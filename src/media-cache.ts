import {
  CINEMATIC_CACHE_NAME,
  MEDIA_PROBE_TIMEOUT_MS,
  PRELOAD_DOWNLOAD_TIMEOUT_MS,
} from "./config";
import type { MediaDiagnostics } from "./protocol";

export interface PreparedMedia {
  blob: Blob;
  diagnostics: MediaDiagnostics;
}

function timeoutError(label: string, timeoutMs: number): DOMException {
  return new DOMException(`${label} excedeu ${timeoutMs} ms.`, "TimeoutError");
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function getCache(): Promise<Cache> {
  if (!("caches" in window)) {
    throw new DOMException(
      "Cache Storage não está disponível neste contexto do navegador.",
      "NotSupportedError",
    );
  }

  return caches.open(CINEMATIC_CACHE_NAME);
}

async function fetchAndStoreCompleteResponse(
  cache: Cache,
  request: Request,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRELOAD_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(request, {
      cache: "no-cache",
      signal: controller.signal,
    });

    if (!response.ok || response.status !== 200) {
      throw new Error(
        `Falha HTTP no MP4: ${response.status} ${response.statusText || "sem descrição"}`,
      );
    }

    // Cache.put consumes the complete response body before resolving. READY is
    // never based only on response headers or media metadata.
    await cache.put(request, response);

    const stored = await cache.match(request);
    if (!stored?.ok) {
      throw new Error("O MP4 não pôde ser relido do Cache Storage após o download.");
    }

    return stored;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCachedCinematic(
  requestUrl: string,
  timeoutMs = MEDIA_PROBE_TIMEOUT_MS,
): Promise<PreparedMedia> {
  const cache = await getCache();
  const request = new Request(requestUrl, { method: "GET" });
  const response = await cache.match(request);

  if (!response?.ok) {
    throw new Error("O MP4 completo não está presente no Cache Storage deste cliente.");
  }

  const blob = await withTimeout(response.blob(), timeoutMs, "Leitura do MP4 em cache");
  if (blob.size <= 0) {
    throw new Error("A entrada do MP4 no Cache Storage está vazia.");
  }

  return {
    blob,
    diagnostics: {
      bytes: blob.size,
      cacheSource: "CACHE_STORAGE",
      contentType: blob.type || response.headers.get("content-type") || undefined,
    },
  };
}

function mediaErrorDescription(video: HTMLVideoElement): string {
  const code = video.error?.code;
  const labelByCode: Record<number, string> = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
  };
  return code === undefined
    ? "Erro de mídia sem código"
    : `${labelByCode[code] ?? "MEDIA_ERR_UNKNOWN"} (${code})`;
}

async function probePlayableData(blob: Blob): Promise<MediaDiagnostics> {
  const video = document.createElement("video");
  const objectUrl = URL.createObjectURL(blob);
  video.preload = "auto";
  video.playsInline = true;
  video.muted = true;
  video.hidden = true;
  video.src = objectUrl;
  document.body.append(video);

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const eventNames = [
          "loadedmetadata",
          "loadeddata",
          "canplay",
          "canplaythrough",
          "progress",
        ] as const;

        const cleanup = (): void => {
          for (const eventName of eventNames) {
            video.removeEventListener(eventName, checkReadyState);
          }
          video.removeEventListener("error", handleError);
        };

        const checkReadyState = (): void => {
          if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
            cleanup();
            resolve();
          }
        };

        const handleError = (): void => {
          cleanup();
          reject(new Error(`O navegador não preparou o MP4: ${mediaErrorDescription(video)}`));
        };

        for (const eventName of eventNames) {
          video.addEventListener(eventName, checkReadyState);
        }
        video.addEventListener("error", handleError, { once: true });
        video.load();
        checkReadyState();
      }),
      MEDIA_PROBE_TIMEOUT_MS,
      "Preparação decodificável do MP4",
    );

    const bufferedEndSeconds =
      video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : undefined;

    return {
      bytes: blob.size,
      contentType: blob.type || undefined,
      durationSeconds: Number.isFinite(video.duration) ? video.duration : undefined,
      readyState: video.readyState,
      bufferedEndSeconds,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function preloadCinematic(requestUrl: string): Promise<MediaDiagnostics> {
  const startedAt = performance.now();
  const cache = await getCache();
  const request = new Request(requestUrl, { method: "GET" });
  let response = await cache.match(request);
  let cacheSource: "CACHE_STORAGE" | "NETWORK" = "CACHE_STORAGE";

  if (!response?.ok) {
    cacheSource = "NETWORK";
    response = await fetchAndStoreCompleteResponse(cache, request);
  }

  const blob = await withTimeout(
    response.blob(),
    PRELOAD_DOWNLOAD_TIMEOUT_MS,
    "Validação do corpo completo do MP4",
  );
  if (blob.size <= 0) {
    throw new Error("O MP4 baixado está vazio.");
  }

  const probe = await probePlayableData(blob);
  return {
    ...probe,
    bytes: blob.size,
    cacheSource,
    contentType: blob.type || response.headers.get("content-type") || undefined,
    preloadMs: Math.round(performance.now() - startedAt),
  };
}
