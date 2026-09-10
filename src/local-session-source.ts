import { CINEMATIC_CACHE_NAME, EXTENSION_ID } from "./config";

export const LOCAL_SESSION_CHANNEL = `${EXTENSION_ID}/local-session-v1`;
export const LOCAL_SESSION_METADATA_KEY = `${EXTENSION_ID}/local-session`;
export const MAX_LOCAL_AUDIO_BYTES = 100_000_000;

// The player consumes this descriptor plus a resolved Blob, never RTC or a path.
export interface LocalSessionSource {
  kind: "LOCAL_SESSION";
  sessionTrackId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  durationSeconds: number;
  ownerConnectionId: string;
  ownerPlayerId: string;
}

export function friendlyAudioName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? "Áudio")
    // Strip control characters from untrusted display names.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f:]/g, "").trim().slice(0, 160) || "Áudio";
}

export function isLocalSessionSource(value: unknown): value is LocalSessionSource {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const keys = ["kind", "sessionTrackId", "name", "size", "mime", "sha256",
    "durationSeconds", "ownerConnectionId", "ownerPlayerId"];
  return Object.keys(v).every((key) => keys.includes(key)) &&
    v.kind === "LOCAL_SESSION" &&
    [v.sessionTrackId, v.ownerConnectionId, v.ownerPlayerId].every(
      (id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id),
    ) && typeof v.name === "string" && v.name === friendlyAudioName(v.name) &&
    Number.isSafeInteger(v.size) && Number(v.size) > 0 && Number(v.size) <= MAX_LOCAL_AUDIO_BYTES &&
    typeof v.mime === "string" && /^audio\/[a-z0-9.+-]{1,64}$/.test(v.mime) &&
    typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256) &&
    typeof v.durationSeconds === "number" && Number.isFinite(v.durationSeconds) && v.durationSeconds > 0;
}

export function assertGm(role: string): void {
  if (role !== "GM") throw new Error("Somente GM pode importar/distribuir áudio.");
}

export function validateAudioFile(file: Blob, name: string, audio = new Audio()): string {
  if (file.size <= 0 || file.size > MAX_LOCAL_AUDIO_BYTES) {
    throw new Error("Selecione um áudio de até 100 MB (100.000.000 bytes).");
  }
  // Extension is only a MIME hint when the OS supplied none; browser probing is mandatory.
  const hints: Record<string, string> = { ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" };
  const mime = file.type.toLowerCase() || hints[name.split(".").pop()?.toLowerCase() ?? ""] || "";
  if (!/^audio\/[a-z0-9.+-]{1,64}$/.test(mime) || !audio.canPlayType(mime)) {
    throw new Error("Formato de áudio não reproduzível neste navegador.");
  }
  return mime;
}

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAudio(blob: Blob, source: LocalSessionSource): Promise<void> {
  if (!isLocalSessionSource(source) || blob.size !== source.size || await sha256(blob) !== source.sha256) {
    throw new Error("Áudio incompleto ou SHA-256 incorreto; cópia descartada.");
  }
}

export async function probeAudio(blob: Blob): Promise<number> {
  const audio = new Audio();
  validateAudioFile(blob, "", audio);
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<number>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        audio.removeEventListener("canplay", ready);
        audio.removeEventListener("error", failed);
        if (error) reject(error);
        else resolve(audio.duration);
      };
      const ready = (): void => {
        if (audio.readyState >= 3 && Number.isFinite(audio.duration) && audio.duration > 0) finish();
      };
      const failed = (): void => finish(new Error("O navegador não conseguiu decodificar o áudio."));
      const timer = setTimeout(() => finish(new Error("Tempo de preparação do áudio excedido.")), 30_000);
      audio.addEventListener("canplay", ready);
      audio.addEventListener("error", failed);
      audio.preload = "auto";
      audio.src = url;
      audio.load();
      ready();
    });
  } finally {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}

export function localAudioCacheKey(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Identidade de cache inválida.");
  return new URL(`./local-session/${hash}`, window.location.href).href;
}

// Same Cache Storage namespace as the existing complete-media cache, separate content keys.
export class LocalSessionCache {
  async get(source: LocalSessionSource): Promise<Blob | undefined> {
    const cache = await caches.open(CINEMATIC_CACHE_NAME);
    const key = localAudioCacheKey(source.sha256);
    const response = await cache.match(key);
    if (!response) return undefined;
    const blob = await response.blob();
    try {
      await verifyAudio(blob, source);
      return blob.slice(0, blob.size, source.mime);
    } catch {
      await cache.delete(key);
      return undefined;
    }
  }

  async put(source: LocalSessionSource, blob: Blob): Promise<Blob> {
    await verifyAudio(blob, source);
    const existing = await this.get(source);
    if (existing) return existing;
    const cache = await caches.open(CINEMATIC_CACHE_NAME);
    await cache.put(localAudioCacheKey(source.sha256), new Response(blob, {
      headers: { "Content-Type": source.mime },
    }));
    const stored = await this.get(source);
    if (!stored) throw new Error("Não foi possível reler o áudio íntegro do cache.");
    return stored;
  }
}

export async function importLocalAudio(file: File, role: string, ownerConnectionId: string,
  ownerPlayerId: string, cache = new LocalSessionCache()): Promise<LocalSessionSource> {
  assertGm(role);
  const mime = validateAudioFile(file, file.name);
  const blob = file.slice(0, file.size, mime);
  const source: LocalSessionSource = {
    kind: "LOCAL_SESSION", sessionTrackId: crypto.randomUUID(),
    name: friendlyAudioName(file.name), size: file.size, mime,
    sha256: await sha256(blob), durationSeconds: await probeAudio(blob),
    ownerConnectionId, ownerPlayerId,
  };
  await cache.put(source, blob);
  return source;
}
