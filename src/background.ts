import OBR, { type Player } from "@owlbear-rodeo/sdk";
import { calculateClockSample, calculateLocalStartAt } from "./clock-sync";
import {
  AUDIO_ACTIVATION_CHANNEL,
  AUDIO_ACTIVATION_POPOVER_ID,
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
  DEFAULT_LOCAL_AUDIO_VOLUMES,
  loadLocalAudioVolumes,
  localAudioStorageKey,
  parseLocalAudioVolumes,
} from "./local-audio-settings";
import {
  compareMusicStates,
  createAuthorityTakeoverMusicState,
  createEmfMusicState,
  createInitialMusicState,
  createLayeredMusicState,
  createManualMusicState,
  createPostCinematicMusicState,
  isCinematicMusicLocked,
  isLayerMusicControlAction,
  isMusicState,
  type LayerMusicControlAction,
  stripLegacyVolumeFields,
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
  type MusicPlaybackStatus,
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
let diagnostics: ClientDiagnostics = { userAgent: navigator.userAgent, musicPlayback: "IDLE" };
let activeRequestId: string | undefined;
let toolRegistered = false;
let clockDiagnostics: ClockDiagnostics | undefined;
let playbackClock: { gmConnectionId: string; offsetGmMinusLocalMs: number } | undefined;
let clockSyncGeneration = 0;
let clockSyncTarget: string | undefined;
let clockSyncStartedAt = 0;
let preferredGmConnectionId: string | undefined;
let validClockSamples = 0;
let musicPlayer: MusicPlayer | undefined;
let musicState: MusicState | undefined;
let musicHydrationPromise: Promise<void> | undefined;
let cinematicCompletionTimer: number | undefined;
let finalizingCinematicStateId: string | undefined;
let pendingGmCommand = Promise.resolve();
let pendingMusicPersistence = Promise.resolve();
let latestMusicCommandIssuedAt = Number.NEGATIVE_INFINITY;
let activationOffered = false;
let activationPopoverOperation = Promise.resolve();
const handledMusicRequests = new Set<string>();
const pendingClockPings = new Map<string, number>();

function queueGmCommand(run: () => Promise<void>): Promise<void> {
  const command = pendingGmCommand.then(run);
  pendingGmCommand = command.catch(() => undefined);
  return command;
}

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

async function syncTool(): Promise<void> {
  if (!toolRegistered) {
    await OBR.tool.create({
      id: TOOL_ID,
      icons: [
        {
          icon: resolveAppUrl("./icon.svg"),
          label: "Cinemática",
          filter: { roles: ["GM", "PLAYER"] },
        },
      ],
      async onClick(_context, elementId) {
        if (activationOffered) {
          await openAudioActivation(elementId);
          return false;
        }
        await openControls(elementId);
        return false;
      },
    });
    toolRegistered = true;
  }
}

async function openControls(elementId?: string): Promise<void> {
  const role = await OBR.player.getRole();
  await OBR.popover.open({
    id: CONTROL_POPOVER_ID,
    url: resolveAppUrl("./controls.html"),
    width: 380,
    height: role === "GM" ? 720 : 260,
    ...(elementId ? {
      anchorElementId: elementId,
      anchorOrigin: { horizontal: "LEFT" as const, vertical: "CENTER" as const },
      transformOrigin: { horizontal: "RIGHT" as const, vertical: "CENTER" as const },
    } : {
      anchorReference: "POSITION" as const,
      anchorPosition: { left: 16, top: 80 },
      transformOrigin: { horizontal: "LEFT" as const, vertical: "TOP" as const },
    }),
  });
}

function openAudioActivation(elementId?: string): Promise<void> {
  return OBR.popover.open({
    id: AUDIO_ACTIVATION_POPOVER_ID,
    url: resolveAppUrl("./audio-activation.html"),
    width: 300,
    height: 194,
    ...(elementId ? { anchorElementId: elementId } : {
      anchorReference: "POSITION" as const,
      anchorPosition: { left: 16, top: 80 },
    }),
    anchorOrigin: { horizontal: "LEFT", vertical: "TOP" },
    transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
  });
}

function reportMusicPlayback(status: MusicPlaybackStatus): void {
  diagnostics = { ...diagnostics, musicPlayback: status };
  void sendStatus().catch((error: unknown) => {
    console.warn("[cinematic-sync] Diagnóstico de áudio indisponível.", error);
  });
  if (status === "BLOCKED" && !activationOffered) {
    activationOffered = true;
    activationPopoverOperation = activationPopoverOperation.then(async () => {
      if (!activationOffered) return;
      try {
        await openAudioActivation();
      } catch {
        await OBR.notification.show(
          "O navegador bloqueou a trilha. Abra Cinemática e escolha Ativar áudio.",
          "WARNING",
        );
      }
    }).catch((error: unknown) => {
      console.warn("[cinematic-sync] Aviso de autoplay indisponível.", error);
    });
  } else if (status !== "BLOCKED" && status !== "STARTING" && activationOffered) {
    activationOffered = false;
    activationPopoverOperation = activationPopoverOperation.then(async () => {
      await OBR.popover.close(AUDIO_ACTIVATION_POPOVER_ID);
    }).catch((error: unknown) => {
      console.warn("[cinematic-sync] Não foi possível fechar a ativação de áudio.", error);
    });
  }
}

function resetClockSync(): void {
  clockSyncTarget = undefined;
  clockDiagnostics = undefined;
  clockSyncGeneration += 1;
  pendingClockPings.clear();
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
    resetClockSync();
    return;
  }

  if (targetConnectionId === identity.connectionId) {
    if (clockSyncTarget !== targetConnectionId) resetClockSync();
    clockSyncTarget = targetConnectionId;
    clockDiagnostics = {
      gmConnectionId: identity.connectionId,
      offsetGmMinusLocalMs: 0,
      roundTripMs: 0,
      samples: CLOCK_SYNC_SAMPLE_COUNT,
    };
    return;
  }

  if (clockSyncTarget === targetConnectionId &&
    (clockDiagnostics || Date.now() - clockSyncStartedAt < 2_000)) {
    return;
  }

  clockSyncTarget = targetConnectionId;
  clockSyncStartedAt = Date.now();
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
  if (message.targetConnectionId !== identity.connectionId || senderConnectionId !== clockSyncTarget) {
    return;
  }

  const originalSentAt = pendingClockPings.get(message.nonce);
  const generation = clockSyncGeneration;
  if (
    originalSentAt === undefined ||
    originalSentAt !== message.clientSentAt ||
    !(await isGmConnection(senderConnectionId)) ||
    generation !== clockSyncGeneration
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

  applyMusicStateIfClockReady();
  await sendStatus();
}

function musicClockReady(state: MusicState): boolean {
  return (
    state.authorityConnectionId === identity.connectionId ||
    clockDiagnostics?.gmConnectionId === state.authorityConnectionId
  );
}

function musicClockOffset(authorityConnectionId: string | undefined): number | undefined {
  if (authorityConnectionId === undefined) return undefined;
  if (authorityConnectionId === identity.connectionId) return 0;
  if (clockDiagnostics?.gmConnectionId === authorityConnectionId) {
    return clockDiagnostics.offsetGmMinusLocalMs;
  }
  // Keep the last usable clock for already-scheduled fades and loops while
  // reconnecting. New snapshots still require a current clock sample.
  if (playbackClock?.gmConnectionId === authorityConnectionId) {
    return playbackClock.offsetGmMinusLocalMs;
  }
}

function gmNowForMusic(authority = playbackClock?.gmConnectionId ?? musicState?.authorityConnectionId): number {
  return Date.now() + (musicClockOffset(authority) ?? 0);
}

function localTimeForMusic(gmTime: number, issuedAtGm: number): number {
  const offset = musicClockOffset(playbackClock?.gmConnectionId ?? musicState?.authorityConnectionId);
  return calculateLocalStartAt(gmTime, issuedAtGm, Date.now(), offset);
}

function applyMusicStateIfClockReady(): void {
  if (musicState && musicPlayer && musicClockReady(musicState)) {
    playbackClock = {
      gmConnectionId: musicState.authorityConnectionId,
      offsetGmMinusLocalMs: musicClockOffset(musicState.authorityConnectionId) ?? 0,
    };
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
  const sanitizedCandidate = stripLegacyVolumeFields(candidate);
  if (musicState && compareMusicStates(sanitizedCandidate, musicState) <= 0) {
    return false;
  }

  musicState = sanitizedCandidate;
  beginClockSyncIfNeeded(sanitizedCandidate.authorityConnectionId);
  applyMusicStateIfClockReady();
  scheduleCinematicMusicCompletion(sanitizedCandidate);
  return true;
}

function persistMusicState(state: MusicState): Promise<void> {
  const write = pendingMusicPersistence.then(async () => {
    if (
      identity.role !== "GM" ||
      state.authorityConnectionId !== identity.connectionId ||
      musicState?.stateId !== state.stateId
    ) {
      return;
    }
    await OBR.room.setMetadata({
      [MUSIC_ROOM_METADATA_KEY]: stripLegacyVolumeFields(state),
    });
  });
  pendingMusicPersistence = write.catch(() => undefined);
  return write;
}

async function broadcastMusicState(
  state: MusicState,
  requestId?: string,
  targetConnectionId?: string,
): Promise<void> {
  const sanitizedState = stripLegacyVolumeFields(state);
  const message = protocolMessage<MusicStateMessage>({
    kind: "MUSIC_STATE",
    requestId,
    targetConnectionId,
    issuedAt: Date.now(),
    state: sanitizedState,
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
  void Promise.allSettled([
    persistMusicState(state),
    broadcastMusicState(state, requestId),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[cinematic-sync] Falha ao publicar estado musical.", result.reason);
      }
    }
  });
}

function scheduleCinematicMusicCompletion(state: MusicState): void {
  if (cinematicCompletionTimer !== undefined) {
    window.clearTimeout(cinematicCompletionTimer);
    cinematicCompletionTimer = undefined;
  }
  if (
    identity.role !== "GM" ||
    state.authorityConnectionId !== identity.connectionId ||
    state.mode !== "CINEMATIC" ||
    !state.cinematic?.outro
  ) {
    return;
  }

  const expectedStateId = state.stateId;
  const delay = Math.max(0, state.cinematic.videoEndsAtGm - Date.now());
  cinematicCompletionTimer = window.setTimeout(() => {
    cinematicCompletionTimer = undefined;
    void queueGmCommand(async () => {
      await finalizeExpiredCinematicMusicState(expectedStateId);
    }).catch(
      (error: unknown) => {
        console.error(
          "[cinematic-sync] Falha ao concluir estado musical da cinemática.",
          error,
        );
      },
    );
  }, delay);
}

async function finalizeExpiredCinematicMusicState(
  expectedStateId?: string,
): Promise<boolean> {
  const current = musicState;
  if (
    !current ||
    current.mode !== "CINEMATIC" ||
    !current.cinematic?.outro ||
    current.authorityConnectionId !== identity.connectionId ||
    identity.role !== "GM" ||
    (expectedStateId !== undefined && current.stateId !== expectedStateId) ||
    Date.now() < current.cinematic.videoEndsAtGm ||
    finalizingCinematicStateId === current.stateId
  ) {
    return false;
  }

  finalizingCinematicStateId = current.stateId;
  try {
    const completed = createPostCinematicMusicState(
      current,
      identity.connectionId,
      crypto.randomUUID(),
      Date.now(),
    );
    await publishMusicState(completed);
    return musicState?.stateId === completed.stateId;
  } finally {
    finalizingCinematicStateId = undefined;
  }
}

async function ensureInitialGmMusicState(): Promise<void> {
  if (identity.role !== "GM") {
    return;
  }
  await finalizeExpiredCinematicMusicState();
  const current = musicState;
  if (current) {
    if (
      current.authorityConnectionId === identity.connectionId ||
      (await isGmConnection(current.authorityConnectionId)) ||
      musicState !== current
    ) {
      return;
    }

    const previousAuthorityNowGm = gmNowForMusic(current.authorityConnectionId);
    const nowGm = Date.now();
    const takeover = createAuthorityTakeoverMusicState(
      current,
      identity.connectionId,
      crypto.randomUUID(),
      previousAuthorityNowGm,
      nowGm,
    );
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
  if (!musicState || musicState.authorityConnectionId !== identity.connectionId) {
    return;
  }
  await finalizeExpiredCinematicMusicState();
  if (!musicState) {
    return;
  }
  if (handledMusicRequests.has(message.requestId) || message.issuedAt <= latestMusicCommandIssuedAt) {
    await broadcastMusicState(musicState, message.requestId, senderConnectionId);
    return;
  }
  latestMusicCommandIssuedAt = message.issuedAt;
  handledMusicRequests.add(message.requestId);
  if (handledMusicRequests.size > 256) {
    const oldest = handledMusicRequests.values().next().value;
    if (oldest !== undefined) handledMusicRequests.delete(oldest);
  }
  const issuedAtGm = Date.now();
  if (isCinematicMusicLocked(musicState, issuedAtGm)) {
    await broadcastMusicState(musicState, message.requestId, senderConnectionId);
    return;
  }
  const stateId = crypto.randomUUID();
  const applyAtGm = Math.max(issuedAtGm + MUSIC_COMMAND_DELAY_MS, musicState.anchorAtGm + 1);
  const next = applyMusicControl(musicState, message.action, stateId, issuedAtGm, applyAtGm);
  if (next === musicState) {
    await broadcastMusicState(musicState, message.requestId, senderConnectionId);
    return;
  }
  await publishMusicState(next, message.requestId);
}

function applyMusicControl(
  state: MusicState, action: MusicControlMessage["action"], stateId: string, issuedAtGm: number, applyAtGm: number,
): MusicState {
  const authority = identity.connectionId;
  if (action.type === "PLAY_EMF") {
    return createEmfMusicState(state, action.emfId, authority, stateId, issuedAtGm, applyAtGm);
  }
  if (isLayerMusicControlAction(action)) {
    return createLayeredMusicState(state, action, authority, stateId, issuedAtGm, applyAtGm);
  }
  if (!state.layers) {
    return createManualMusicState(state, action, authority, stateId, issuedAtGm, applyAtGm);
  }
  let layeredAction: LayerMusicControlAction;
  switch (action.type) {
    case "SELECT_TRACK":
      layeredAction = state.playing
        ? { type: "REPLACE_TRACK", trackId: action.trackId }
        : { type: "SEEK_LAYER", trackId: action.trackId, positionSeconds: 0 };
      break;
    case "SEEK":
      layeredAction = { type: "SEEK_LAYER", trackId: state.trackId, positionSeconds: action.positionSeconds };
      break;
    case "PLAY":
    case "PAUSE":
      layeredAction = { type: action.type === "PLAY" ? "PLAY_LAYER" : "PAUSE_LAYER", trackId: state.trackId };
      break;
  }
  return createLayeredMusicState(state, layeredAction, authority, stateId, issuedAtGm, applyAtGm);
}

async function handleMusicStateRequest(
  message: MusicStateRequestMessage,
  senderConnectionId: string,
): Promise<void> {
  await musicHydrationPromise;
  if (identity.role !== "GM") {
    return;
  }
  await queueGmCommand(ensureInitialGmMusicState);
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
      if (event.connectionId === identity.connectionId) {
        await queueGmCommand(() => handleCinematicPlay(message, event.connectionId));
      } else {
        await handleCinematicPlay(message, event.connectionId);
      }
      break;
    case "MUSIC_CONTROL":
      if (event.connectionId === identity.connectionId) {
        await queueGmCommand(() => handleMusicControl(message, event.connectionId));
      }
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

async function handleCinematicPlay(message: PlayMessage, sender: string): Promise<void> {
  await musicHydrationPromise;
  const accepted = await acceptMusicState(message.musicState, sender);
  if (!accepted && (musicState?.stateId !== message.musicState.stateId ||
    musicState.authorityConnectionId !== sender || !(await isGmConnection(sender)))) {
    return;
  }
  if (accepted && sender === identity.connectionId) {
    void persistMusicState(message.musicState).catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao persistir handoff musical.", error);
    });
  }
  await openCinematic(message, sender);
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

function recoverMusicState(): void {
  beginClockSyncIfNeeded(musicState?.authorityConnectionId);
  void requestMusicState().catch((error: unknown) => {
    console.warn("[cinematic-sync] Não foi possível solicitar o estado musical.", error);
  });
}

function recoverMusicAfterReconnect(): void {
  recoverMusicState();
  void refreshParty().catch((error: unknown) => {
    console.warn("[cinematic-sync] Participantes indisponíveis após reconexão.", error);
  });
}

function localVolumesForPlayer(playerId: string) {
  try {
    return loadLocalAudioVolumes(localStorage, playerId);
  } catch {
    return DEFAULT_LOCAL_AUDIO_VOLUMES;
  }
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
  const [connectionId, playerId, name, role] = await Promise.all([
    OBR.player.getConnectionId(),
    OBR.player.getId(),
    OBR.player.getName(),
    OBR.player.getRole(),
  ]);
  identity = { connectionId, name, role };
  musicPlayer = new MusicPlayer(
    {
      gmNow: gmNowForMusic,
      toLocalTime: localTimeForMusic,
    },
    localVolumesForPlayer(playerId),
    reportMusicPlayback,
  );
  const volumeStorageKey = localAudioStorageKey(playerId);
  window.addEventListener("storage", (event) => {
    if (event.key === volumeStorageKey) {
      musicPlayer?.setLocalVolumes(parseLocalAudioVolumes(event.newValue));
    }
  });
  musicHydrationPromise = (async () => {
    try {
      const metadata = await OBR.room.getMetadata();
      const persistedMusicState = metadata[MUSIC_ROOM_METADATA_KEY];
      if (isMusicState(persistedMusicState)) {
        const accepted = await acceptMusicState(persistedMusicState);
        // A reload creates a new connection. Keep the last valid snapshot as
        // the takeover base if the previous GM connection has already left.
        if (!accepted && !musicState && identity.role === "GM" &&
          (await roleForConnection(persistedMusicState.authorityConnectionId)) === undefined &&
          !musicState) {
          musicState = stripLegacyVolumeFields(persistedMusicState);
        }
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
  OBR.broadcast.onMessage(AUDIO_ACTIVATION_CHANNEL, (event) => {
    if (event.connectionId !== identity.connectionId) return;
    if (event.data === "ACTIVATE" && musicState && musicClockReady(musicState)) {
      musicPlayer?.retryAutoplay();
    } else if (event.data === "OPEN_CONTROLS" && activationOffered) {
      void openControls().then(() => OBR.popover.close(AUDIO_ACTIVATION_POPOVER_ID)).catch((error: unknown) => {
        console.warn("[cinematic-sync] Não foi possível abrir os controles de áudio.", error);
      });
    }
  });
  OBR.party.onChange((updatedPlayers) => {
    void refreshParty(updatedPlayers).then(recoverMusicState).catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao atualizar Party.", error);
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
    const connectionChanged = identity.connectionId !== player.connectionId;
    identity = {
      connectionId: player.connectionId,
      name: player.name,
      role: player.role,
    };
    void syncTool().catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao atualizar a Tool.", error);
    });
    if (connectionChanged) {
      resetClockSync();
      recoverMusicAfterReconnect();
    } else {
      beginClockSyncIfNeeded();
    }
    if (player.role === "GM") {
      void (async () => {
        await musicHydrationPromise;
        await queueGmCommand(ensureInitialGmMusicState);
      })().catch((error: unknown) => {
        console.error("[cinematic-sync] Falha ao iniciar estado musical.", error);
      });
    }
  });

  window.addEventListener("online", recoverMusicAfterReconnect);
  window.setInterval(() => {
    if (musicState && musicClockReady(musicState)) {
      musicPlayer?.reconcile(musicState);
    } else {
      recoverMusicAfterReconnect();
    }
  }, MUSIC_DRIFT_CHECK_INTERVAL_MS);
  recoverMusicAfterReconnect();
  void syncTool().catch((error: unknown) => {
    console.warn("[cinematic-sync] Não foi possível registrar os controles.", error);
  });
  void sendStatus().catch((error: unknown) => {
    console.warn("[cinematic-sync] Não foi possível enviar o diagnóstico inicial.", error);
  });
  void runPreload().catch((error: unknown) => {
    console.warn("[cinematic-sync] Não foi possível publicar o diagnóstico de mídia.", error);
  });
  await musicHydrationPromise;
  await queueGmCommand(ensureInitialGmMusicState);
}

OBR.onReady(() => {
  void initialize().catch((error: unknown) => {
    console.error("[cinematic-sync] Inicialização do background falhou.", error);
  });
});
