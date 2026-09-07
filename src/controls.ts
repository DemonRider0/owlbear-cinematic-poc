import OBR, { type Player } from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CINEMATIC_MUSIC_SYNC,
  CONTROL_POPOVER_ID,
  EMFS,
  MUSIC_TRACK_CROSSFADE_MS,
  MUSIC_TRACKS,
  PLAY_START_DELAY_MS,
  STATUS_REFRESH_INTERVAL_MS,
  getEmfConfig,
  getMusicLoopCycleSeconds,
  getMusicTrackConfig,
} from "./config";
import {
  compareMusicStates,
  createCinematicMusicState,
  isCinematicMusicLocked,
  isEmfActive,
  musicPositionAtGm,
  type MusicControlAction,
  type MusicState,
} from "./music-state";
import {
  isProtocolMessage,
  protocolMessage,
  type ClientDiagnostics,
  type ClientStatusMessage,
  type HelloMessage,
  type MusicControlMessage,
  type MusicStateRequestMessage,
  type PlayMessage,
} from "./protocol";
import { isReadyForPlayback } from "./state-machine";

interface Participant {
  connectionId: string;
  name: string;
  role: "GM" | "PLAYER";
}

interface StoredStatus {
  phase: ClientStatusMessage["phase"];
  requestId?: string;
  reportedAt: number;
  diagnostics: ClientDiagnostics;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Elemento obrigatório ausente: ${selector}`);
  }
  return element;
}

const readyCount = requiredElement<HTMLElement>("#ready-count");
const overallState = requiredElement<HTMLElement>("#overall-state");
const syncCount = requiredElement<HTMLElement>("#sync-count");
const clientList = requiredElement<HTMLUListElement>("#client-list");
const policyMessage = requiredElement<HTMLElement>("#policy-message");
const playButton = requiredElement<HTMLButtonElement>("#play-button");
const diagnosticsField = requiredElement<HTMLTextAreaElement>("#diagnostics");
const copyButton = requiredElement<HTMLButtonElement>("#copy-diagnostics");
const copyResult = requiredElement<HTMLElement>("#copy-result");
const musicCurrent = requiredElement<HTMLElement>("#music-current");
const musicToggle = requiredElement<HTMLButtonElement>("#music-toggle");
const musicCurrentTime = requiredElement<HTMLElement>("#music-current-time");
const musicProgress = requiredElement<HTMLInputElement>("#music-progress");
const musicDuration = requiredElement<HTMLElement>("#music-duration");
const musicStatus = requiredElement<HTMLElement>("#music-status");
const musicTrackButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-track-id]"),
];
const emfStatus = requiredElement<HTMLElement>("#emf-status");
const emfButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-emf-id]"),
];

let localConnectionId = "";
let localName = "";
let participants = new Map<string, Participant>();
const statuses = new Map<string, StoredStatus>();
let sendingPlay = false;
let activePlayRequestId: string | undefined;
let musicState: MusicState | undefined;
let sendingMusicCommand = false;
let seekingMusic = false;
let clientsReadyForMusic = false;

function mergeDiagnostics(
  current: ClientDiagnostics | undefined,
  update: ClientDiagnostics,
): ClientDiagnostics {
  return {
    ...current,
    ...update,
    clock: update.clock ?? current?.clock,
    media: { ...current?.media, ...update.media },
    playback: { ...current?.playback, ...update.playback },
  };
}

function receiveStatus(connectionId: string, message: ClientStatusMessage): void {
  const current = statuses.get(connectionId);
  if (current && message.reportedAt < current.reportedAt) {
    return;
  }

  statuses.set(connectionId, {
    phase: message.phase,
    requestId: message.requestId,
    reportedAt: message.reportedAt,
    diagnostics: mergeDiagnostics(current?.diagnostics, message.diagnostics),
  });
  render();
}

function shortConnectionId(connectionId: string): string {
  return connectionId.length > 8 ? connectionId.slice(0, 8) : connectionId;
}

function phaseLabel(status: StoredStatus | undefined): string {
  if (!status) {
    return "preparando";
  }
  const labels: Record<StoredStatus["phase"], string> = {
    LOADING: "preparando",
    READY: "pronto",
    ARMED: "aguardando início",
    FADING_IN: "iniciando",
    PLAYING: "em reprodução",
    FADING_OUT: "encerrando",
    IDLE: "pronto",
    ERROR: "erro",
  };
  return labels[status.phase];
}

function mediaReady(status: StoredStatus | undefined): boolean {
  return status !== undefined && isReadyForPlayback(status.phase);
}

function clockReady(status: StoredStatus | undefined): boolean {
  return status?.diagnostics.clock?.gmConnectionId === localConnectionId;
}

function currentParticipants(): Participant[] {
  return [...participants.values()].sort((left, right) => {
    if (left.connectionId === localConnectionId) return -1;
    if (right.connectionId === localConnectionId) return 1;
    return left.name.localeCompare(right.name);
  });
}

function connectionIsGm(connectionId: string): boolean {
  return participants.get(connectionId)?.role === "GM";
}

function updateDiagnostics(participantList: Participant[]): void {
  diagnosticsField.value = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      controllingConnectionId: localConnectionId,
      playStartDelayMs: PLAY_START_DELAY_MS,
      musicTrackCrossfadeMs: MUSIC_TRACK_CROSSFADE_MS,
      cinematicMusicSync: CINEMATIC_MUSIC_SYNC,
      musicState: musicState ?? null,
      readyCriterion:
        "Cache.put concluído + Blob não vazio relido do Cache Storage + readyState >= HAVE_FUTURE_DATA",
      clients: participantList.map((participant) => ({
        ...participant,
        status: statuses.get(participant.connectionId) ?? null,
      })),
    },
    null,
    2,
  );
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function receiveMusicState(candidate: MusicState): void {
  if (musicState && compareMusicStates(candidate, musicState) <= 0) {
    return;
  }
  musicState = candidate;
  sendingMusicCommand = false;
  renderMusic();
  render();
}

function renderMusic(): void {
  const state = musicState;
  const disabled =
    state === undefined ||
    sendingMusicCommand ||
    Boolean(activePlayRequestId) ||
    !clientsReadyForMusic ||
    (state !== undefined && isCinematicMusicLocked(state, Date.now()));
  musicToggle.disabled = disabled;
  musicProgress.disabled = disabled;
  for (const button of musicTrackButtons) {
    button.disabled = disabled;
  }
  for (const button of emfButtons) {
    button.disabled = disabled;
  }

  if (!state) {
    musicCurrent.textContent = "Carregando faixas…";
    musicStatus.textContent = "Aguardando estado sincronizado…";
    emfStatus.textContent = "Aguardando estado sincronizado…";
    return;
  }

  const now = Date.now();
  const track = getMusicTrackConfig(state.trackId);
  const position = musicPositionAtGm(state, now);
  const activeEmf = state.emf ? getEmfConfig(state.emf.id) : undefined;
  const emfPlaying = isEmfActive(state, now);
  musicCurrent.textContent = track.label;
  musicToggle.textContent = state.playing ? "⏸" : "▶";
  musicToggle.setAttribute(
    "aria-label",
    state.playing ? "Pausar música" : "Reproduzir música",
  );
  musicProgress.max = String(getMusicLoopCycleSeconds(track.id));
  if (!seekingMusic) {
    musicProgress.value = String(position);
    musicCurrentTime.textContent = formatTime(position);
  }
  musicDuration.textContent = formatTime(getMusicLoopCycleSeconds(track.id));
  musicStatus.textContent = !clientsReadyForMusic
    ? "Aguardando áudio e relógios dos clientes…"
    : sendingMusicCommand
      ? "Sincronizando comando…"
      : state.mode === "CINEMATIC"
        ? "Continuidade automática da cinemática"
        : state.mode === "EMF"
          ? `Música parada durante ${activeEmf?.label ?? "EMF"}`
        : state.playing
          ? "Reproduzindo em todos os clientes"
          : "Pausada em todos os clientes";

  for (const button of musicTrackButtons) {
    const selected = button.dataset.trackId === state.trackId;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }

  emfStatus.textContent = sendingMusicCommand
    ? "Sincronizando comando…"
    : state.mode !== "EMF" || !activeEmf
      ? "Nenhum EMF em reprodução."
      : now < (state.emf?.startAtGm ?? 0)
        ? `${activeEmf.label} agendado…`
        : emfPlaying
          ? `${activeEmf.label} em reprodução em todos os clientes`
          : `${activeEmf.label} concluído — silêncio`;
  for (const button of emfButtons) {
    const selected = emfPlaying && button.dataset.emfId === state.emf?.id;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function render(): void {
  const participantList = currentParticipants();
  const cinematicRunning =
    musicState !== undefined && isCinematicMusicLocked(musicState, Date.now());
  const readyTotal = participantList.filter((participant) =>
    mediaReady(statuses.get(participant.connectionId)),
  ).length;
  const synchronizedTotal = participantList.filter((participant) =>
    clockReady(statuses.get(participant.connectionId)),
  ).length;
  const allMediaReady = participantList.length > 0 && readyTotal === participantList.length;
  const allClocksReady =
    participantList.length > 0 && synchronizedTotal === participantList.length;
  clientsReadyForMusic = allMediaReady && allClocksReady;
  const hasError = participantList.some(
    (participant) => statuses.get(participant.connectionId)?.phase === "ERROR",
  );
  if (
    activePlayRequestId &&
    participantList.every((participant) => {
      const status = statuses.get(participant.connectionId);
      return (
        status !== undefined &&
        status.requestId === activePlayRequestId &&
        status.phase === "IDLE"
      );
    })
  ) {
    activePlayRequestId = undefined;
  }

  if (hasError) {
    overallState.textContent = "Estado: Erro";
  } else if (activePlayRequestId || cinematicRunning) {
    overallState.textContent = "Estado: Em reprodução";
  } else if (allMediaReady && allClocksReady) {
    overallState.textContent = "Estado: Pronta";
  } else {
    overallState.textContent = "Estado: Preparando…";
  }

  readyCount.textContent = `Clientes prontos: ${readyTotal} / ${participantList.length}`;
  syncCount.textContent = `Sincronizados: ${synchronizedTotal} / ${participantList.length}`;
  clientList.replaceChildren();

  for (const participant of participantList) {
    const status = statuses.get(participant.connectionId);
    const item = document.createElement("li");
    const dot = document.createElement("span");
    const name = document.createElement("span");
    const state = document.createElement("span");
    dot.className = "dot";
    if (mediaReady(status)) dot.classList.add("ready");
    if (status?.phase === "ERROR") dot.classList.add("error");
    name.className = "client-name";
    name.textContent = `${participant.name || "Cliente"} (${shortConnectionId(participant.connectionId)})`;
    state.className = "client-state";
    state.textContent = phaseLabel(status);
    item.append(dot, name, state);
    clientList.append(item);
  }

  if (hasError) {
    policyMessage.textContent = "Há clientes com erro. Consulte o diagnóstico técnico.";
  } else if (!allMediaReady) {
    policyMessage.textContent = "Reprodução bloqueada até todos os clientes estarem prontos.";
  } else if (!allClocksReady) {
    policyMessage.textContent = "Mídia pronta; aguardando sincronização automática dos relógios.";
  } else if (activePlayRequestId || cinematicRunning) {
    policyMessage.textContent = "Cinemática em andamento.";
  } else {
    policyMessage.textContent = "Todos os clientes estão prontos.";
  }

  playButton.disabled =
    sendingPlay ||
    Boolean(activePlayRequestId) ||
    cinematicRunning ||
    sendingMusicCommand ||
    !allMediaReady ||
    !allClocksReady ||
    !musicState;
  renderMusic();
  updateDiagnostics(participantList);
}

function toParticipant(player: Player): Participant {
  return {
    connectionId: player.connectionId,
    name: player.name,
    role: player.role,
  };
}

async function refreshParticipants(updatedPlayers?: Player[]): Promise<void> {
  const [players, role] = await Promise.all([
    updatedPlayers ? Promise.resolve(updatedPlayers) : OBR.party.getPlayers(),
    OBR.player.getRole(),
  ]);

  if (role !== "GM") {
    await lockOutNonGm();
    return;
  }

  const next = new Map<string, Participant>();
  for (const player of players) {
    next.set(player.connectionId, toParticipant(player));
  }
  next.set(localConnectionId, {
    connectionId: localConnectionId,
    name: localName,
    role: "GM",
  });
  participants = next;

  for (const connectionId of statuses.keys()) {
    if (!participants.has(connectionId)) {
      statuses.delete(connectionId);
    }
  }
  render();
}

async function sendHello(): Promise<void> {
  const message = protocolMessage<HelloMessage>({
    kind: "HELLO",
    requestId: crypto.randomUUID(),
    issuedAt: Date.now(),
  });
  await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, { destination: "ALL" });
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

async function sendMusicControl(action: MusicControlAction): Promise<void> {
  if (
    !musicState ||
    sendingMusicCommand ||
    !clientsReadyForMusic ||
    isCinematicMusicLocked(musicState, Date.now()) ||
    (await OBR.player.getRole()) !== "GM"
  ) {
    return;
  }
  sendingMusicCommand = true;
  renderMusic();
  const message = protocolMessage<MusicControlMessage>({
    kind: "MUSIC_CONTROL",
    requestId: crypto.randomUUID(),
    issuedAt: Date.now(),
    action,
  });
  try {
    await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, {
      destination: "ALL",
    });
  } catch (error) {
    sendingMusicCommand = false;
    renderMusic();
    throw error;
  }
}

async function lockOutNonGm(): Promise<void> {
  document.body.classList.remove("booting");
  document.body.classList.add("unauthorized");
  document.querySelector("#controls")?.remove();
  try {
    await OBR.popover.close(CONTROL_POPOVER_ID);
  } catch (error) {
    console.warn("[cinematic-sync] Não foi possível fechar o painel não autorizado.", error);
  }
}

async function dispatchPlay(): Promise<void> {
  sendingPlay = true;
  render();
  try {
    await refreshParticipants();
    const participantList = currentParticipants();
    const canPlay =
      (await OBR.player.getRole()) === "GM" &&
      musicState !== undefined &&
      !isCinematicMusicLocked(musicState, Date.now()) &&
      !sendingMusicCommand &&
      participantList.length > 0 &&
      participantList.every((participant) => {
        const status = statuses.get(participant.connectionId);
        return mediaReady(status) && clockReady(status);
      });

    if (!canPlay) {
      return;
    }

    const issuedAt = Math.max(Date.now(), (musicState?.updatedAtGm ?? 0) + 1);
    const requestId = crypto.randomUUID();
    const startAtGm = issuedAt + PLAY_START_DELAY_MS;
    const message = protocolMessage<PlayMessage>({
      kind: "PLAY",
      requestId,
      issuedAt,
      startAtGm,
      musicState: createCinematicMusicState(
        localConnectionId,
        requestId,
        (musicState?.revision ?? 0) + 1,
        issuedAt,
        startAtGm,
      ),
    });
    activePlayRequestId = message.requestId;
    try {
      await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, { destination: "ALL" });
    } catch (error) {
      activePlayRequestId = undefined;
      throw error;
    }
  } finally {
    sendingPlay = false;
    render();
  }
}

async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(diagnosticsField.value);
    copyResult.textContent = "Diagnóstico copiado.";
  } catch {
    diagnosticsField.focus();
    diagnosticsField.select();
    copyResult.textContent = "Selecione e copie o texto do campo.";
  }
}

async function initialize(): Promise<void> {
  const [connectionId, name, role] = await Promise.all([
    OBR.player.getConnectionId(),
    OBR.player.getName(),
    OBR.player.getRole(),
  ]);
  localConnectionId = connectionId;
  localName = name;

  if (role !== "GM") {
    await lockOutNonGm();
    return;
  }

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    if (!isProtocolMessage(event.data)) {
      return;
    }
    if (event.data.kind === "CLIENT_STATUS") {
      receiveStatus(event.connectionId, event.data);
    } else if (
      event.data.kind === "MUSIC_STATE" &&
      (event.data.targetConnectionId === undefined ||
        event.data.targetConnectionId === localConnectionId) &&
      event.data.state.authorityConnectionId === event.connectionId &&
      connectionIsGm(event.connectionId)
    ) {
      receiveMusicState(event.data.state);
    } else if (
      event.data.kind === "PLAY" &&
      event.data.musicState.authorityConnectionId === event.connectionId &&
      connectionIsGm(event.connectionId)
    ) {
      receiveMusicState(event.data.musicState);
    }
  });
  OBR.party.onChange((players) => {
    void refreshParticipants(players).catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao atualizar clientes do painel.", error);
    });
    void sendHello().catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao solicitar status após alteração da Party.", error);
    });
  });
  OBR.player.onChange((player) => {
    if (player.role !== "GM") {
      void lockOutNonGm();
    }
  });
  playButton.addEventListener("click", () => {
    void dispatchPlay().catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao enviar PLAY.", error);
    });
  });
  copyButton.addEventListener("click", () => {
    void copyDiagnostics();
  });
  musicToggle.addEventListener("click", () => {
    if (!musicState) return;
    void sendMusicControl({ type: musicState.playing ? "PAUSE" : "PLAY" }).catch(
      (error: unknown) => {
        console.error("[cinematic-sync] Falha no Play/Pause musical.", error);
      },
    );
  });
  musicProgress.addEventListener("input", () => {
    seekingMusic = true;
    musicCurrentTime.textContent = formatTime(Number(musicProgress.value));
  });
  musicProgress.addEventListener("change", () => {
    const positionSeconds = Number(musicProgress.value);
    seekingMusic = false;
    void sendMusicControl({ type: "SEEK", positionSeconds }).catch(
      (error: unknown) => {
        console.error("[cinematic-sync] Falha no seek musical.", error);
      },
    );
  });
  for (const button of musicTrackButtons) {
    button.addEventListener("click", () => {
      const track = MUSIC_TRACKS.find(
        (candidate) => candidate.id === button.dataset.trackId,
      );
      if (!track) return;
      void sendMusicControl({ type: "SELECT_TRACK", trackId: track.id }).catch(
        (error: unknown) => {
          console.error("[cinematic-sync] Falha ao trocar faixa.", error);
        },
      );
    });
  }
  for (const button of emfButtons) {
    button.addEventListener("click", () => {
      const emf = EMFS.find(
        (candidate) => candidate.id === button.dataset.emfId,
      );
      if (!emf) return;
      void sendMusicControl({ type: "PLAY_EMF", emfId: emf.id }).catch(
        (error: unknown) => {
          console.error("[cinematic-sync] Falha ao reproduzir EMF.", error);
        },
      );
    });
  }

  await refreshParticipants();
  document.body.classList.remove("booting");
  await sendHello();
  await requestMusicState();
  renderMusic();
  window.setInterval(renderMusic, 250);
  window.setInterval(() => {
    void sendHello().catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao atualizar status dos clientes.", error);
    });
  }, STATUS_REFRESH_INTERVAL_MS);
}

OBR.onReady(() => {
  void initialize().catch((error: unknown) => {
    console.error("[cinematic-sync] Inicialização do painel falhou.", error);
  });
});
