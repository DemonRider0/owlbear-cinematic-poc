import OBR, { type Player } from "@owlbear-rodeo/sdk";
import { calculateClockSample, calculateLocalStartAt } from "./clock-sync";
import {
  BROADCAST_CHANNEL,
  CINEMATIC_MODAL_ID,
  CLOCK_SYNC_SAMPLE_COUNT,
  CLOCK_SYNC_SAMPLE_INTERVAL_MS,
  CONTROL_POPOVER_ID,
  getCinematicRequestUrl,
  MUSIC_COMMAND_DELAY_MS,
  MUSIC_DRIFT_CHECK_INTERVAL_MS,
  MUSIC_ROOM_METADATA_KEY,
  resolveAppUrl,
  TOOL_ID,
} from "./config";
import { toSerializableError } from "./errors";
import { preloadCinematic } from "./media-cache";
import { MusicPlayer } from "./music-player";
import {
  compareMusicStates,
  createInitialMusicState,
  createManualMusicState,
  isCinematicMusicLocked,
  isMusicState,
  musicPositionAtGm,
  type MusicState,
} from "./music-state";
import {
  isProtocolMessage,
  protocolMessage,
  type ClientDiagnostics,
  type ClientStatusMessage,
  type ClockDiagnostics,
  type ClockPingMessage,
  type ClockPongMessage,
  type MusicControlMessage,
  type MusicStateMessage,
  type MusicStateRequestMessage,
  type PlayMessage,
} from "./protocol";
import {
  canTransition,
  isReadyForPlayback,
  transition,
  type ClientPhase,
} from "./state-machine";

interface LocalIdentity {
  connectionId: string;
  name: string;
  role: "GM" | "PLAYER";
}

let identity: LocalIdentity;
let partyPlayers: Player[] = [];
let phase: ClientPhase = "LOADING";
let diagnostics: ClientDiagnostics = { userAgent: navigator.userAgent };
let activeRequestId: string | undefined;
let toolRegistered = false;
let clockDiagnostics: ClockDiagnostics | undefined;
let clockSyncGeneration = 0;
let clockSyncTarget: string | undefined;
let preferredGmConnectionId: string | undefined;
let validClockSamples = 0;
let musicPlayer: MusicPlayer | undefined;
let musicState: MusicState | undefined;
let musicHydrationPromise: Promise<void> | undefined;
const pendingClockPings = new Map<string, number>();

function mergeDiagnostics(
  current: ClientDiagnostics,
  update: ClientDiagnostics,
): ClientDiagnostics {
  return {
    ...current,
    ...update,
    clock: update.clock ?? current.clock,
    media: { ...current.media, ...update.media },
    playback: { ...current.playback, ...update.playback },
  };
}

function moveTo(next: ClientPhase): void {
  if (phase === next) {
    return;
  }
  phase = transition(phase, next);
}

async function sendStatus(): Promise<void> {
  const message = protocolMessage<ClientStatusMessage>({
    kind: "CLIENT_STATUS",
    phase,
    source: "BACKGROUND",
    requestId: activeRequestId,
    reportedAt: Date.now(),
    diagnostics: {
      ...diagnostics,
      clock: clockDiagnostics,
    },
  });
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, { destination: "ALL" });
}

async function refreshParty(players?: Player[]): Promise<void> {
  const latestPlayers = players ?? (await OBR.party.getPlayers());
  partyPlayers = latestPlayers.filter(
    (player) => player.connectionId !== identity.connectionId,
  );
  beginClockSyncIfNeeded();
}

async function roleForConnection(
  connectionId: string,
): Promise<"GM" | "PLAYER" | undefined> {
  if (connectionId === identity.connectionId) {
    identity.role = await OBR.player.getRole();
    return identity.role;
  }

  let player = partyPlayers.find((candidate) => candidate.connectionId === connectionId);
  if (!player) {
    await refreshParty();
    player = partyPlayers.find((candidate) => candidate.connectionId === connectionId);
  }
  return player?.role;
}

async function isGmConnection(connectionId: string): Promise<boolean> {
  return (await roleForConnection(connectionId)) === "GM";
}

async function syncGmTool(role: "GM" | "PLAYER"): Promise<void> {
  if (role === "GM" && !toolRegistered) {
    await OBR.tool.create({
      id: TOOL_ID,
      icons: [
        {
          icon: resolveAppUrl("./icon.svg"),
          label: "Cinemática",
          filter: { roles: ["GM"] },
        },
      ],
      async onClick(_context, elementId) {
        if ((await OBR.player.getRole()) !== "GM") {
          console.warn("[cinematic-sync] Abertura do painel ignorada: cliente não é GM.");
          return false;
        }

        await OBR.popover.open({
          id: CONTROL_POPOVER_ID,
          url: resolveAppUrl("./controls.html"),
          width: 380,
          height: 720,
          anchorElementId: elementId,
          anchorOrigin: { horizontal: "LEFT", vertical: "CENTER" },
          transformOrigin: { horizontal: "RIGHT", vertical: "CENTER" },
        });
        return false;
      },
    });
    toolRegistered = true;
    return;
  }

  if (role !== "GM" && toolRegistered) {
    await OBR.tool.remove(TOOL_ID);
    toolRegistered = false;
  }
}

function beginClockSyncIfNeeded(preferredConnectionId?: string): void {
  if (preferredConnectionId) {
    preferredGmConnectionId = preferredConnectionId;
  }

  const preferredIsLocalGm =
    preferredGmConnectionId === identity.connectionId && identity.role === "GM";
  const preferredRemoteGm = partyPlayers.find(
    (player) =>
      player.connectionId === preferredGmConnectionId && player.role === "GM",
  );
  const targetConnectionId = preferredIsLocalGm
    ? identity.connectionId
    : (preferredRemoteGm?.connectionId ??
      (identity.role === "GM"
        ? identity.connectionId
        : partyPlayers.find((player) => player.role === "GM")?.connectionId));

  if (!targetConnectionId) {
    clockSyncTarget = undefined;
    clockDiagnostics = undefined;
    return;
  }

  if (targetConnectionId === identity.connectionId) {
    clockSyncTarget = targetConnectionId;
    clockDiagnostics = {
      gmConnectionId: identity.connectionId,
      offsetGmMinusLocalMs: 0,
      roundTripMs: 0,
      samples: CLOCK_SYNC_SAMPLE_COUNT,
    };
    applyMusicStateIfClockReady();
    return;
  }

  if (clockSyncTarget === targetConnectionId && clockDiagnostics) {
    return;
  }

  clockSyncTarget = targetConnectionId;
  clockDiagnostics = undefined;
  validClockSamples = 0;
  pendingClockPings.clear();
  const generation = ++clockSyncGeneration;

  for (let index = 0; index < CLOCK_SYNC_SAMPLE_COUNT; index += 1) {
    window.setTimeout(() => {
      if (generation === clockSyncGeneration) {
        void sendClockPing(targetConnectionId).catch((error: unknown) => {
          console.error("[cinematic-sync] Falha na amostra de relógio.", error);
        });
      }
    }, index * CLOCK_SYNC_SAMPLE_INTERVAL_MS);
  }
}

async function sendClockPing(gmConnectionId: string): Promise<void> {
  const nonce = crypto.randomUUID();
  const clientSentAt = Date.now();
  pendingClockPings.set(nonce, clientSentAt);
  const message = protocolMessage<ClockPingMessage>({
    kind: "CLOCK_PING",
    nonce,
    targetConnectionId: gmConnectionId,
    clientSentAt,
  });
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, { destination: "ALL" });
}

async function handleClockPing(
  message: ClockPingMessage,
  senderConnectionId: string,
): Promise<void> {
  if (identity.role !== "GM" || message.targetConnectionId !== identity.connectionId) {
    return;
  }

  const response = protocolMessage<ClockPongMessage>({
    kind: "CLOCK_PONG",
    nonce: message.nonce,
    targetConnectionId: senderConnectionId,
    clientSentAt: message.clientSentAt,
    gmTime: Date.now(),
  });
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, response, { destination: "ALL" });
}

async function handleClockPong(
  message: ClockPongMessage,
  senderConnectionId: string,
): Promise<void> {
  if (message.targetConnectionId !== identity.connectionId) {
    return;
  }

  const originalSentAt = pendingClockPings.get(message.nonce);
  if (
    originalSentAt === undefined ||
    originalSentAt !== message.clientSentAt ||
    !(await isGmConnection(senderConnectionId))
  ) {
    return;
  }

  pendingClockPings.delete(message.nonce);
  const receivedAt = Date.now();
  const { roundTripMs, offsetGmMinusLocalMs } = calculateClockSample(
    originalSentAt,
    receivedAt,
    message.gmTime,
  );
  validClockSamples += 1;

  if (!clockDiagnostics || roundTripMs < clockDiagnostics.roundTripMs) {
    clockDiagnostics = {
      gmConnectionId: senderConnectionId,
      offsetGmMinusLocalMs,
      roundTripMs,
      samples: validClockSamples,
    };
  } else {
    clockDiagnostics = { ...clockDiagnostics, samples: validClockSamples };
  }

  await sendStatus();
  applyMusicStateIfClockReady();
}

function musicClockReady(state: MusicState): boolean {
  return (
    state.authorityConnectionId === identity.connectionId ||
    clockDiagnostics?.gmConnectionId === state.authorityConnectionId
  );
}

function gmNowForMusic(): number {
  const authorityConnectionId = musicState?.authorityConnectionId;
  const offset =
    authorityConnectionId &&
    authorityConnectionId !== identity.connectionId &&
    clockDiagnostics?.gmConnectionId === authorityConnectionId
      ? clockDiagnostics.offsetGmMinusLocalMs
      : 0;
  return Date.now() + offset;
}

function localTimeForMusic(gmTime: number, issuedAtGm: number): number {
  const authorityConnectionId = musicState?.authorityConnectionId;
  const offset =
    authorityConnectionId &&
    clockDiagnostics?.gmConnectionId === authorityConnectionId
      ? clockDiagnostics.offsetGmMinusLocalMs
      : authorityConnectionId === identity.connectionId
        ? 0
        : undefined;
  return calculateLocalStartAt(gmTime, issuedAtGm, Date.now(), offset);
}

function applyMusicStateIfClockReady(): void {
  if (musicState && musicPlayer && musicClockReady(musicState)) {
    musicPlayer.applyState(musicState);
  }
}

async function acceptMusicState(
  candidate: MusicState,
  senderConnectionId?: string,
): Promise<boolean> {
  if (
    senderConnectionId !== undefined &&
    (candidate.authorityConnectionId !== senderConnectionId ||
      !(await isGmConnection(senderConnectionId)))
  ) {
    console.warn(
      `[cinematic-sync] Estado musical não autorizado ignorado (${senderConnectionId}).`,
    );
    return false;
  }
  if (
    senderConnectionId === undefined &&
    !(await isGmConnection(candidate.authorityConnectionId))
  ) {
    return false;
  }
  if (musicState && compareMusicStates(candidate, musicState) <= 0) {
    return false;
  }

  musicState = candidate;
  beginClockSyncIfNeeded(candidate.authorityConnectionId);
  applyMusicStateIfClockReady();
  return true;
}

async function persistMusicState(state: MusicState): Promise<void> {
  if (
    identity.role !== "GM" ||
    state.authorityConnectionId !== identity.connectionId
  ) {
    return;
  }
  await OBR.room.setMetadata({ [MUSIC_ROOM_METADATA_KEY]: state });
}

async function broadcastMusicState(
  state: MusicState,
  requestId?: string,
  targetConnectionId?: string,
): Promise<void> {
  const message = protocolMessage<MusicStateMessage>({
    kind: "MUSIC_STATE",
    requestId,
    targetConnectionId,
    issuedAt: Date.now(),
    state,
  });
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, {
    destination: "ALL",
  });
}

async function publishMusicState(
  state: MusicState,
  requestId?: string,
): Promise<void> {
  const accepted = await acceptMusicState(state, identity.connectionId);
  if (!accepted) {
    return;
  }
  const results = await Promise.allSettled([
    persistMusicState(state),
    broadcastMusicState(state, requestId),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[cinematic-sync] Falha ao publicar estado musical.", result.reason);
    }
  }
}

async function ensureInitialGmMusicState(): Promise<void> {
  if (identity.role !== "GM") {
    return;
  }
  if (musicState) {
    if (
      musicState.authorityConnectionId === identity.connectionId ||
      (await isGmConnection(musicState.authorityConnectionId))
    ) {
      return;
    }

    const nowGm = Date.now();
    const projectedPosition = musicPositionAtGm(musicState, gmNowForMusic());
    const takeover: MusicState = {
      schemaVersion: musicState.schemaVersion,
      stateId: crypto.randomUUID(),
      revision: musicState.revision + 1,
      authorityConnectionId: identity.connectionId,
      updatedAtGm: Math.max(nowGm, musicState.updatedAtGm + 1),
      mode: "MANUAL",
      trackId: musicState.trackId,
      playing: musicState.playing,
      positionSeconds: projectedPosition,
      anchorAtGm: nowGm,
    };
    await publishMusicState(takeover);
    return;
  }
  const initial = createInitialMusicState(
    identity.connectionId,
    crypto.randomUUID(),
    Date.now(),
  );
  await publishMusicState(initial);
}

async function handleMusicControl(
  message: MusicControlMessage,
  senderConnectionId: string,
): Promise<void> {
  await musicHydrationPromise;
  if (
    identity.role !== "GM" ||
    senderConnectionId !== identity.connectionId
  ) {
    return;
  }
  if (!(await isGmConnection(senderConnectionId))) {
    console.warn(
      `[cinematic-sync] Controle musical não autorizado ignorado (${senderConnectionId}).`,
    );
    return;
  }

  await ensureInitialGmMusicState();
  if (!musicState) {
    return;
  }
  const issuedAtGm = Date.now();
  if (isCinematicMusicLocked(musicState, issuedAtGm)) {
    await broadcastMusicState(musicState, message.requestId, senderConnectionId);
    return;
  }
  const next = createManualMusicState(
    musicState,
    message.action,
    identity.connectionId,
    crypto.randomUUID(),
    issuedAtGm,
    issuedAtGm + MUSIC_COMMAND_DELAY_MS,
  );
  await publishMusicState(next, message.requestId);
}

async function handleMusicStateRequest(
  message: MusicStateRequestMessage,
  senderConnectionId: string,
): Promise<void> {
  await musicHydrationPromise;
  if (identity.role !== "GM") {
    return;
  }
  await ensureInitialGmMusicState();
  if (musicState) {
    if (musicState.authorityConnectionId !== identity.connectionId) {
      return;
    }
    await broadcastMusicState(
      musicState,
      message.requestId,
      senderConnectionId,
    );
  }
}

async function handleMusicStateMessage(
  message: MusicStateMessage,
  senderConnectionId: string,
): Promise<void> {
  if (
    message.targetConnectionId !== undefined &&
    message.targetConnectionId !== identity.connectionId
  ) {
    return;
  }
  await acceptMusicState(message.state, senderConnectionId);
}

function localStartTime(message: PlayMessage, gmConnectionId: string): number {
  const offset =
    clockDiagnostics?.gmConnectionId === gmConnectionId
      ? clockDiagnostics.offsetGmMinusLocalMs
      : undefined;

  // Uma amostra de relógio pode não estar disponível para um cliente recém-chegado.
  // A margem automática é preservada sem presumir relógios iguais; o diagnóstico
  // torna esse fallback visível para o GM.
  return calculateLocalStartAt(
    message.startAtGm,
    message.issuedAt,
    Date.now(),
    offset,
  );
}

async function openCinematic(
  message: PlayMessage,
  gmConnectionId: string,
): Promise<void> {
  if (!isReadyForPlayback(phase)) {
    console.warn(`[cinematic-sync] PLAY ignorado no estado ${phase}.`);
    return;
  }

  moveTo("ARMED");
  activeRequestId = message.requestId;
  diagnostics = {
    ...diagnostics,
    error: undefined,
    playback: undefined,
  };
  await sendStatus();

  const modalUrl = new URL(resolveAppUrl("./cinematic.html"));
  modalUrl.searchParams.set("requestId", message.requestId);
  modalUrl.searchParams.set(
    "startAtLocal",
    String(localStartTime(message, gmConnectionId)),
  );

  try {
    await OBR.modal.open({
      id: CINEMATIC_MODAL_ID,
      url: modalUrl.href,
      fullScreen: true,
      hidePaper: true,
      hideBackdrop: true,
    });
  } catch (error) {
    moveTo("ERROR");
    const serialized = toSerializableError(error);
    diagnostics = mergeDiagnostics(diagnostics, {
      error: { stage: "MODAL_PREPARE", ...serialized },
    });
    await sendStatus();
  }
}

function acceptModalStatus(message: ClientStatusMessage): void {
  if (
    message.source !== "MODAL" ||
    !activeRequestId ||
    message.requestId !== activeRequestId
  ) {
    return;
  }

  diagnostics = mergeDiagnostics(diagnostics, message.diagnostics);
  if (phase !== message.phase && canTransition(phase, message.phase)) {
    moveTo(message.phase);
  }
}

async function handleProtocolEvent(event: {
  data: unknown;
  connectionId: string;
}): Promise<void> {
  if (!isProtocolMessage(event.data)) {
    return;
  }

  const message = event.data;
  switch (message.kind) {
    case "HELLO":
      if (await isGmConnection(event.connectionId)) {
        beginClockSyncIfNeeded(
          musicState?.authorityConnectionId ?? event.connectionId,
        );
        await sendStatus();
      }
      break;
    case "PLAY":
      if (await isGmConnection(event.connectionId)) {
        await musicHydrationPromise;
        const accepted = await acceptMusicState(
          message.musicState,
          event.connectionId,
        );
        const alreadyCurrent =
          musicState?.stateId === message.musicState.stateId;
        if (!accepted && !alreadyCurrent) {
          console.warn(
            `[cinematic-sync] PLAY stale ignorado (${message.requestId}).`,
          );
          break;
        }
        if (
          accepted &&
          message.musicState.authorityConnectionId === identity.connectionId
        ) {
          void persistMusicState(message.musicState).catch((error: unknown) => {
            console.error(
              "[cinematic-sync] Falha ao persistir handoff musical.",
              error,
            );
          });
        }
        await openCinematic(message, event.connectionId);
      } else {
        console.warn(
          `[cinematic-sync] PLAY não autorizado ignorado (${event.connectionId}).`,
        );
      }
      break;
    case "MUSIC_CONTROL":
      await handleMusicControl(message, event.connectionId);
      break;
    case "MUSIC_STATE":
      await handleMusicStateMessage(message, event.connectionId);
      break;
    case "MUSIC_STATE_REQUEST":
      await handleMusicStateRequest(message, event.connectionId);
      break;
    case "CLOCK_PING":
      await handleClockPing(message, event.connectionId);
      break;
    case "CLOCK_PONG":
      await handleClockPong(message, event.connectionId);
      break;
    case "CLIENT_STATUS":
      if (event.connectionId === identity.connectionId) {
        acceptModalStatus(message);
      }
      break;
  }
}

async function requestMusicState(): Promise<void> {
  const message = protocolMessage<MusicStateRequestMessage>({
    kind: "MUSIC_STATE_REQUEST",
    requestId: crypto.randomUUID(),
    issuedAt: Date.now(),
  });
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, {
    destination: "ALL",
  });
}

async function runPreload(): Promise<void> {
  try {
    const [media] = await Promise.all([
      preloadCinematic(getCinematicRequestUrl()),
      musicPlayer?.preload() ?? Promise.resolve(),
    ]);
    diagnostics = mergeDiagnostics(diagnostics, {
      media,
    });
    moveTo("READY");
  } catch (error) {
    moveTo("ERROR");
    const serialized = toSerializableError(error);
    diagnostics = mergeDiagnostics(diagnostics, {
      error: { stage: "PRELOAD", ...serialized },
    });
    console.error("[cinematic-sync] Preload falhou.", error);
  }
  await sendStatus();
}

async function initialize(): Promise<void> {
  const [connectionId, name, role, players] = await Promise.all([
    OBR.player.getConnectionId(),
    OBR.player.getName(),
    OBR.player.getRole(),
    OBR.party.getPlayers(),
  ]);
  identity = { connectionId, name, role };
  partyPlayers = players.filter((player) => player.connectionId !== connectionId);
  musicPlayer = new MusicPlayer({
    gmNow: gmNowForMusic,
    toLocalTime: localTimeForMusic,
  });
  musicHydrationPromise = (async () => {
    try {
      const metadata = await OBR.room.getMetadata();
      const persistedMusicState = metadata[MUSIC_ROOM_METADATA_KEY];
      if (isMusicState(persistedMusicState)) {
        await acceptMusicState(persistedMusicState);
      }
    } catch (error) {
      console.warn(
        "[cinematic-sync] Estado musical persistido indisponível; usando Broadcast.",
        error,
      );
    }
  })();

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    void handleProtocolEvent(event).catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao processar broadcast.", error);
    });
  });
  OBR.party.onChange((updatedPlayers) => {
    void refreshParty(updatedPlayers).catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao atualizar Party.", error);
    });
    void requestMusicState().catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao solicitar estado musical.", error);
    });
  });
  OBR.room.onMetadataChange((metadata) => {
    const candidate = metadata[MUSIC_ROOM_METADATA_KEY];
    if (isMusicState(candidate)) {
      void acceptMusicState(candidate).catch((error: unknown) => {
        console.error("[cinematic-sync] Estado musical persistido inválido.", error);
      });
    }
  });
  OBR.player.onChange((player) => {
    identity = {
      connectionId: player.connectionId,
      name: player.name,
      role: player.role,
    };
    void syncGmTool(player.role).catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao atualizar a Tool do GM.", error);
    });
    beginClockSyncIfNeeded();
    if (player.role === "GM") {
      void (async () => {
        await musicHydrationPromise;
        await ensureInitialGmMusicState();
      })().catch((error: unknown) => {
        console.error("[cinematic-sync] Falha ao iniciar estado musical.", error);
      });
    }
  });

  await syncGmTool(role);
  beginClockSyncIfNeeded();
  await musicHydrationPromise;
  await ensureInitialGmMusicState();
  await requestMusicState();
  window.setInterval(() => {
    if (musicState) {
      musicPlayer?.reconcile(musicState);
    }
  }, MUSIC_DRIFT_CHECK_INTERVAL_MS);
  await sendStatus();
  await runPreload();
}

OBR.onReady(() => {
  void initialize().catch((error: unknown) => {
    console.error("[cinematic-sync] Inicialização do background falhou.", error);
  });
});
