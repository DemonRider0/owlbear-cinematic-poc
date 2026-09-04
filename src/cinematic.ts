import OBR from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CINEMATIC_MODAL_ID,
  FADE_IN_MS,
  FADE_OUT_MS,
  getCinematicRequestUrl,
  MODAL_CLOSE_RETRY_MS,
  MODAL_PREPARE_TIMEOUT_MS,
  PLAYBACK_WATCHDOG_GRACE_MS,
} from "./config";
import { toSerializableError } from "./errors";
import { getCachedCinematic } from "./media-cache";
import {
  protocolMessage,
  type ClientDiagnostics,
  type ClientStatusMessage,
} from "./protocol";
import { transition, type ClientPhase } from "./state-machine";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Elemento obrigatório ausente: ${selector}`);
  }
  return element;
}

const layer = requiredElement<HTMLElement>("#cinematic-layer");
const video = requiredElement<HTMLVideoElement>("#cinematic-video");

document.documentElement.style.setProperty("--fade-in-ms", `${FADE_IN_MS}ms`);
document.documentElement.style.setProperty("--fade-out-ms", `${FADE_OUT_MS}ms`);

let phase: ClientPhase = "ARMED";
let requestId = "unknown";
let diagnostics: ClientDiagnostics = {
  userAgent: navigator.userAgent,
  playback: { waitingEvents: 0 },
};
let objectUrl: string | undefined;
let finishing = false;
let watchdog: ReturnType<typeof setTimeout> | undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function moveTo(next: ClientPhase): void {
  if (phase !== next) {
    phase = transition(phase, next);
  }
}

async function sendStatus(): Promise<void> {
  const message = protocolMessage<ClientStatusMessage>({
    kind: "CLIENT_STATUS",
    phase,
    source: "MODAL",
    requestId,
    reportedAt: Date.now(),
    diagnostics,
  });
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, { destination: "ALL" });
}

async function reportPhase(next: ClientPhase): Promise<void> {
  moveTo(next);
  await sendStatus();
}

function clearWatchdog(): void {
  if (watchdog !== undefined) {
    clearTimeout(watchdog);
    watchdog = undefined;
  }
}

function releaseMedia(): void {
  clearWatchdog();
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  }
}

async function closeModalWithRetry(): Promise<void> {
  try {
    await OBR.modal.close(CINEMATIC_MODAL_ID);
    return;
  } catch (firstError) {
    console.error("[cinematic-sync] Primeira tentativa de fechar o modal falhou.", firstError);
  }

  await delay(MODAL_CLOSE_RETRY_MS);
  try {
    await OBR.modal.close(CINEMATIC_MODAL_ID);
  } catch (error) {
    const serialized = toSerializableError(error);
    if (phase !== "ERROR") {
      moveTo("ERROR");
    }
    diagnostics = {
      ...diagnostics,
      error: { stage: "MODAL_CLOSE", ...serialized },
    };
    await sendStatus();
    console.error("[cinematic-sync] Modal não pôde ser fechado.", error);
  }
}

async function closeWithError(
  stage: "MODAL_PREPARE" | "PLAY" | "PLAYBACK",
  error: unknown,
): Promise<void> {
  if (finishing) {
    return;
  }
  finishing = true;
  const serialized = toSerializableError(error);
  moveTo("ERROR");
  diagnostics = {
    ...diagnostics,
    error: { stage, ...serialized },
  };
  await sendStatus();
  layer.classList.remove("visible");
  await delay(FADE_OUT_MS);
  releaseMedia();
  await closeModalWithRetry();
}

async function finishNormally(): Promise<void> {
  if (finishing) {
    return;
  }
  finishing = true;
  clearWatchdog();
  diagnostics = {
    ...diagnostics,
    playback: {
      ...diagnostics.playback,
      endedAt: Date.now(),
    },
  };
  await reportPhase("FADING_OUT");
  layer.classList.remove("visible");
  await delay(FADE_OUT_MS);
  moveTo("IDLE");
  await sendStatus();
  releaseMedia();
  await closeModalWithRetry();
}

function mediaErrorDescription(): string {
  const code = video.error?.code;
  const labels: Record<number, string> = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
  };
  return code === undefined
    ? "Erro de mídia sem código"
    : `${labels[code] ?? "MEDIA_ERR_UNKNOWN"} (${code})`;
}

async function waitForPlayableData(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const events = ["loadeddata", "canplay", "canplaythrough", "progress"] as const;

    const cleanup = (): void => {
      clearTimeout(timer);
      for (const eventName of events) {
        video.removeEventListener(eventName, check);
      }
      video.removeEventListener("error", fail);
    };

    const check = (): void => {
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        cleanup();
        resolve();
      }
    };

    const fail = (): void => {
      cleanup();
      reject(new Error(`Falha ao preparar o vídeo no modal: ${mediaErrorDescription()}`));
    };

    for (const eventName of events) {
      video.addEventListener(eventName, check);
    }
    video.addEventListener("error", fail, { once: true });
    const timer = setTimeout(
      () => {
        cleanup();
        reject(
          new DOMException(
            `Preparação do modal excedeu ${MODAL_PREPARE_TIMEOUT_MS} ms.`,
            "TimeoutError",
          ),
        );
      },
      MODAL_PREPARE_TIMEOUT_MS,
    );
    video.load();
    check();
  });
}

async function prepareVideo(): Promise<void> {
  const prepared = await getCachedCinematic(
    getCinematicRequestUrl(),
    MODAL_PREPARE_TIMEOUT_MS,
  );
  diagnostics = {
    ...diagnostics,
    media: prepared.diagnostics,
  };
  objectUrl = URL.createObjectURL(prepared.blob);
  video.controls = false;
  video.disablePictureInPicture = true;
  video.playsInline = true;
  video.src = objectUrl;
  await waitForPlayableData();
  diagnostics = {
    ...diagnostics,
    media: {
      ...diagnostics.media,
      durationSeconds: Number.isFinite(video.duration) ? video.duration : undefined,
      readyState: video.readyState,
      bufferedEndSeconds:
        video.buffered.length > 0
          ? video.buffered.end(video.buffered.length - 1)
          : undefined,
    },
  };
}

async function startPlayback(startAtLocal: number): Promise<void> {
  diagnostics = {
    ...diagnostics,
    playback: {
      ...diagnostics.playback,
      scheduledLocalAt: startAtLocal,
    },
  };

  await delay(Math.max(0, startAtLocal - Date.now()));
  if (finishing) {
    return;
  }

  await reportPhase("FADING_IN");
  const playCalledAt = Date.now();
  diagnostics = {
    ...diagnostics,
    playback: {
      ...diagnostics.playback,
      playCalledAt,
      playCallLatenessMs: playCalledAt - startAtLocal,
    },
  };

  video.addEventListener(
    "playing",
    () => {
      diagnostics = {
        ...diagnostics,
        playback: { ...diagnostics.playback, playingEventAt: Date.now() },
      };
      void sendStatus().catch((error: unknown) => {
        console.error("[cinematic-sync] Falha ao reportar evento playing.", error);
      });
    },
    { once: true },
  );

  // Reprodução audível: sem muted e sem manipulação de volume. A chamada única
  // de play() inicia o vídeo MP4 e sua faixa AAC integrada em conjunto.
  const playPromise = video.play();
  layer.classList.add("visible");

  try {
    await playPromise;
  } catch (error) {
    await closeWithError("PLAY", error);
    return;
  }

  diagnostics = {
    ...diagnostics,
    playback: { ...diagnostics.playback, playResolvedAt: Date.now() },
  };
  await sendStatus();

  if (Number.isFinite(video.duration) && video.duration > 0) {
    watchdog = setTimeout(() => {
      void closeWithError(
        "PLAYBACK",
        new DOMException("O vídeo não emitiu ended dentro do prazo esperado.", "TimeoutError"),
      );
    }, video.duration * 1_000 + PLAYBACK_WATCHDOG_GRACE_MS);
  }

  await delay(FADE_IN_MS);
  if (!finishing) {
    await reportPhase("PLAYING");
  }
}

async function initialize(): Promise<void> {
  const parameters = new URLSearchParams(window.location.search);
  requestId = parameters.get("requestId") ?? "";
  const startAtLocal = Number(parameters.get("startAtLocal"));
  if (!requestId || !Number.isFinite(startAtLocal)) {
    await closeWithError(
      "MODAL_PREPARE",
      new Error("Parâmetros requestId/startAtLocal inválidos."),
    );
    return;
  }

  try {
    await prepareVideo();
  } catch (error) {
    await closeWithError("MODAL_PREPARE", error);
    return;
  }

  video.addEventListener("ended", () => {
    void finishNormally().catch((error: unknown) => {
      console.error("[cinematic-sync] Falha no encerramento normal.", error);
    });
  });
  video.addEventListener("error", () => {
    void closeWithError("PLAYBACK", new Error(mediaErrorDescription())).catch(
      (error: unknown) => {
        console.error("[cinematic-sync] Falha no tratamento de erro de mídia.", error);
      },
    );
  });
  video.addEventListener("waiting", () => {
    diagnostics = {
      ...diagnostics,
      playback: {
        ...diagnostics.playback,
        waitingEvents: (diagnostics.playback?.waitingEvents ?? 0) + 1,
      },
    };
  });

  await startPlayback(startAtLocal);
}

OBR.onReady(() => {
  void initialize().catch((error: unknown) => {
    void closeWithError("MODAL_PREPARE", error);
  });
});
