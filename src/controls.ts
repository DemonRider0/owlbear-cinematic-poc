import OBR, { type Player } from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CINEMATIC_MUSIC_SYNC,
  EMFS,
  MUSIC_TRACK_CROSSFADE_MS,
  MUSIC_TRACKS,
  PLAY_START_DELAY_MS,
  STATUS_REFRESH_INTERVAL_MS,
  getEmfConfig,
  getMusicLoop,
  type MusicTrackId,
} from "./config";
import {
  compareMusicStates,
  createCinematicMusicState,
  getMusicLayer,
  getMusicMixVolume,
  isCinematicMusicLocked,
  isEmfActive,
  musicLayerPositionAtGm,
  musicLayerStatusAtGm,
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
import {
  clampLocalVolume,
  loadLocalAudioVolumes,
  localAudioStorageKey,
  parseLocalAudioVolumes,
  saveLocalAudioVolumes,
  type LocalAudioVolumes,
} from "./local-audio-settings";

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

interface TrackControls {
  card: HTMLElement;
  label: string;
  status: HTMLElement;
  replace: HTMLButtonElement;
  add: HTMLButtonElement;
  toggle: HTMLButtonElement;
  stop: HTMLButtonElement;
  seek: HTMLInputElement;
  position: HTMLElement;
  volume: HTMLInputElement;
  volumeValue: HTMLOutputElement;
  legacy: boolean;
}

interface PendingMusicCommand {
  action: MusicControlAction;
  expiresAt: number;
}

function requiredElement<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
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
const panelTitle = requiredElement<HTMLElement>("h1");
const musicHeading = requiredElement<HTMLElement>("#music-heading");
const musicStatus = requiredElement<HTMLElement>("#music-status");
const musicTrackTemplate = requiredElement<HTMLTemplateElement>("#music-track-template");
const musicTrackList = requiredElement<HTMLElement>("#music-track-list");
const musicLegacyList = requiredElement<HTMLElement>("#music-legacy-list");
const musicLegacyStatus = requiredElement<HTMLElement>("#music-legacy-status");
const musicVolumeInput = requiredElement<HTMLInputElement>("#music-volume");
const musicVolumeValue = requiredElement<HTMLOutputElement>(
  "#music-volume-value",
);
const emfStatus = requiredElement<HTMLElement>("#emf-status");
const emfHeading = requiredElement<HTMLElement>("#emf-heading");
const effectsVolumeInput = requiredElement<HTMLInputElement>("#effects-volume");
const effectsVolumeValue = requiredElement<HTMLOutputElement>(
  "#effects-volume-value",
);
const emfButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-emf-id]"),
];
const trackControls = new Map<MusicTrackId, TrackControls>();
const pendingMusicCommands = new Map<string, PendingMusicCommand>();
let latestMusicCommandIssuedAt = Number.NEGATIVE_INFINITY;
const MUSIC_COMMAND_ACK_TIMEOUT_MS = 5_000;

let localConnectionId = "";
let localName = "";
let participants = new Map<string, Participant>();
const statuses = new Map<string, StoredStatus>();
let sendingPlay = false;
let activePlayRequestId: string | undefined;
let musicState: MusicState | undefined;
let musicCommandQueue = Promise.resolve();
let musicCommandError = "";
let clientsReadyForMusic = false;
let localPlayerId = "";
let localVolumes: LocalAudioVolumes = {
  musicVolume: 1,
  effectsVolume: 1,
};

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

function setVolumeControlValues(): void {
  musicVolumeInput.value = String(Math.round(localVolumes.musicVolume * 100));
  effectsVolumeInput.value = String(
    Math.round(localVolumes.effectsVolume * 100),
  );
  musicVolumeValue.textContent = `${musicVolumeInput.value}%`;
  effectsVolumeValue.textContent = `${effectsVolumeInput.value}%`;
}

function persistLocalVolumes(): void {
  try {
    localVolumes = saveLocalAudioVolumes(
      localStorage,
      localPlayerId,
      localVolumes,
    );
  } catch (error) {
    console.warn(
      "[cinematic-sync] Não foi possível persistir os volumes locais.",
      error,
    );
  }
}

function updateLocalVolume(kind: "music" | "effects"): void {
  if (kind === "music") {
    localVolumes.musicVolume = clampLocalVolume(
      Number(musicVolumeInput.value) / 100,
    );
    musicVolumeValue.textContent = `${musicVolumeInput.value}%`;
  } else {
    localVolumes.effectsVolume = clampLocalVolume(
      Number(effectsVolumeInput.value) / 100,
    );
    effectsVolumeValue.textContent = `${effectsVolumeInput.value}%`;
  }
  persistLocalVolumes();
}

function initializeLocalVolumeControls(playerId: string): void {
  localPlayerId = playerId;
  localVolumes = loadLocalAudioVolumes(localStorage, playerId);
  setVolumeControlValues();
  musicVolumeInput.disabled = false;
  effectsVolumeInput.disabled = false;
  musicVolumeInput.addEventListener("input", () => {
    updateLocalVolume("music");
  });
  effectsVolumeInput.addEventListener("input", () => {
    updateLocalVolume("effects");
  });
  const storageKey = localAudioStorageKey(playerId);
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey) {
      localVolumes = parseLocalAudioVolumes(event.newValue);
      setVolumeControlValues();
    }
  });
}

function configurePlayerPanel(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-gm-only]")) {
    element.remove();
  }
  panelTitle.textContent = "Volumes de áudio";
  musicHeading.textContent = "Volume das Trilhas";
  emfHeading.textContent = "Volume dos Efeitos";
  document.body.classList.add("player-panel");
  trackControls.clear();
  pendingMusicCommands.clear();
}

function receiveMusicState(candidate: MusicState, requestId?: string): void {
  if (requestId !== undefined) pendingMusicCommands.delete(requestId);
  if (!musicState || compareMusicStates(candidate, musicState) > 0) {
    musicState = candidate;
  }
  render();
}

function panelGmTime(state: MusicState | undefined): number {
  const clock = statuses.get(localConnectionId)?.diagnostics.clock;
  const offset = state && clock &&
    state.authorityConnectionId !== localConnectionId &&
    clock.gmConnectionId === state.authorityConnectionId
    ? clock.offsetGmMinusLocalMs
    : 0;
  return Date.now() + offset;
}

function musicControlsDisabled(): boolean {
  return !musicState || sendingPlay || Boolean(activePlayRequestId) ||
    !clientsReadyForMusic || isCinematicMusicLocked(musicState, panelGmTime(musicState));
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function updateMixValue(controls: TrackControls): void {
  setText(controls.volumeValue, `${controls.volume.value}%`);
}

function willPlay(trackId: MusicTrackId, playing: boolean): boolean {
  for (const { action } of pendingMusicCommands.values()) {
    if (action.type === "REPLACE_TRACK") playing = action.trackId === trackId;
    else if (action.type === "PLAY_EMF") playing = false;
    else if ("trackId" in action && action.trackId === trackId) {
      if (action.type === "PAUSE_LAYER" || action.type === "STOP_LAYER") playing = false;
      if (action.type === "PLAY_LAYER" || action.type === "ADD_TRACK") playing = true;
    }
  }
  return playing;
}

function initializeTrackControls(): void {
  for (const { id, label } of MUSIC_TRACKS) {
    const fragment = musicTrackTemplate.content.cloneNode(true) as DocumentFragment;
    const controls: TrackControls = {
      card: requiredElement(".music-track", fragment),
      label,
      status: requiredElement(".track-status", fragment),
      replace: requiredElement(".track-replace", fragment),
      add: requiredElement(".track-add", fragment),
      toggle: requiredElement(".track-toggle", fragment),
      stop: requiredElement(".track-stop", fragment),
      seek: requiredElement(".track-seek", fragment),
      position: requiredElement(".track-position", fragment),
      volume: requiredElement(".track-volume", fragment),
      volumeValue: requiredElement(".track-volume-value", fragment),
      legacy: id === "o-porao" || id === "o-idolo",
    };
    setText(requiredElement(".track-name", fragment), label);
    const seekEnd = getMusicLoop(id).seamSeconds;
    controls.seek.max = String((Math.ceil(seekEnd * 10) - 1) / 10);
    setText(requiredElement(".track-duration", fragment), formatTime(seekEnd));
    controls.seek.setAttribute("aria-label", `Posição de ${label}`);
    controls.volume.id = `track-volume-${id}`;
    controls.volume.setAttribute("aria-label", `Volume de mixagem de ${label}`);
    requiredElement<HTMLLabelElement>(".track-mix-label", fragment).htmlFor = controls.volume.id;
    controls.volumeValue.htmlFor.add(controls.volume.id);
    controls.replace.setAttribute("aria-label", `Substituir a mixagem por ${label}`);
    controls.add.setAttribute("aria-label", `Adicionar ${label} à mixagem`);
    controls.stop.setAttribute("aria-label", `Parar ${label}`);
    controls.stop.title = "Parar";

    controls.replace.addEventListener("click", () => sendMusicControl({ type: "REPLACE_TRACK", trackId: id }));
    controls.add.addEventListener("click", () => sendMusicControl({ type: "ADD_TRACK", trackId: id }));
    controls.stop.addEventListener("click", () => sendMusicControl({ type: "STOP_LAYER", trackId: id }));
    controls.toggle.addEventListener("click", () => {
      const layer = musicState && getMusicLayer(musicState, id);
      const status = layer && musicLayerStatusAtGm(layer, panelGmTime(musicState));
      sendMusicControl({ type: willPlay(id, status === "PLAYING") ? "PAUSE_LAYER" : "PLAY_LAYER", trackId: id });
    });
    controls.seek.addEventListener("input", () => setText(controls.position, formatTime(controls.seek.valueAsNumber)));
    controls.seek.addEventListener("change", () => {
      sendMusicControl({ type: "SEEK_LAYER", trackId: id, positionSeconds: controls.seek.valueAsNumber });
    });
    controls.volume.addEventListener("input", () => updateMixValue(controls));
    controls.volume.addEventListener("change", () => {
      sendMusicControl({ type: "SET_MIX_VOLUME", trackId: id, volume: controls.volume.valueAsNumber / 100 });
    });

    trackControls.set(id, controls);
    (controls.legacy ? musicLegacyList : musicTrackList).append(fragment);
  }
}

function renderTrackControls(state: MusicState | undefined, now: number, disabled: boolean): void {
  const pending = Array.from(pendingMusicCommands.values(), ({ action }) => action).reverse();
  let legacyPlaying = 0;
  for (const [trackId, controls] of trackControls) {
    const layer = state && getMusicLayer(state, trackId);
    const status = layer ? musicLayerStatusAtGm(layer, now) : "STOPPED";
    const labels = {
      PLAYING: "Em reprodução",
      PAUSING: "Pausando",
      PAUSED: "Pausada",
      STOPPING: "Encerrando",
      STOPPED: "Parada",
    };
    const audible = status === "PLAYING" || status === "STOPPING" || status === "PAUSING";
    const playing = willPlay(trackId, status === "PLAYING");
    const label = playing ? "Pausar" : "Reproduzir";
    if (audible && controls.legacy) legacyPlaying += 1;
    controls.card.dataset.playing = String(audible);
    setText(controls.status, state ? labels[status] : "Aguardando");
    setText(controls.toggle, playing ? "⏸" : "▶");
    controls.toggle.setAttribute("aria-label", `${label} ${controls.label}`);
    controls.toggle.title = label;
    controls.replace.disabled = disabled;
    controls.add.disabled = disabled;
    controls.toggle.disabled = disabled;
    controls.stop.disabled = disabled || status === "STOPPED" || status === "STOPPING";
    controls.seek.disabled = disabled || status === "STOPPING";
    controls.volume.disabled = disabled;

    const pendingSeek = pending.find((action) => action.type === "SEEK_LAYER" && action.trackId === trackId);
    if (!controls.seek.matches(":active")) {
      const position = pendingSeek?.type === "SEEK_LAYER" ? pendingSeek.positionSeconds
        : layer ? musicLayerPositionAtGm(layer, now) : 0;
      controls.seek.valueAsNumber = Math.min(position, Number(controls.seek.max));
      setText(controls.position, formatTime(position));
    }
    const pendingVolume = pending.find((action) => action.type === "SET_MIX_VOLUME" && action.trackId === trackId);
    if (!controls.volume.matches(":active")) {
      const volume = pendingVolume?.type === "SET_MIX_VOLUME" ? pendingVolume.volume
        : state ? getMusicMixVolume(state, trackId) : 1;
      controls.volume.valueAsNumber = Math.round(volume * 100);
      updateMixValue(controls);
    }
  }
  setText(musicLegacyStatus, legacyPlaying === 0 ? "" : `(${legacyPlaying} em reprodução)`);
}

function renderMusic(): void {
  const state = musicState;
  const now = panelGmTime(state);
  const disabled = musicControlsDisabled();
  renderTrackControls(state, now, disabled);
  for (const button of emfButtons) {
    button.disabled = disabled;
  }

  const activeEmf = state?.emf ? getEmfConfig(state.emf.id) : undefined;
  const emfPlaying = state !== undefined && isEmfActive(state, now);
  const message = !state ? "Aguardando estado sincronizado…"
    : musicCommandError || (!clientsReadyForMusic
    ? "Aguardando áudio e relógios dos clientes…"
    : pendingMusicCommands.size > 0
      ? "Sincronizando comando…"
      : isCinematicMusicLocked(state, now)
        ? "Continuidade automática da cinemática"
        : emfPlaying ? `Trilhas pausadas durante ${activeEmf?.label ?? "EMF"}` : "");
  setText(musicStatus, message);

  setText(emfStatus, !state ? "Aguardando estado sincronizado…"
    : state.mode !== "EMF" || !activeEmf
      ? "Nenhum EMF em reprodução."
      : now < (state.emf?.startAtGm ?? 0)
        ? `${activeEmf.label} agendado…`
        : emfPlaying
          ? `${activeEmf.label} em reprodução em todos os clientes`
          : `${activeEmf.label} concluído — silêncio`);
  for (const button of emfButtons) {
    const selected = emfPlaying && button.dataset.emfId === state?.emf?.id;
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
    const playback = status?.diagnostics.musicPlayback;
    state.textContent = playback === "BLOCKED" ? "áudio bloqueado"
      : playback === "ERROR" ? "erro de áudio" : phaseLabel(status);
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
    pendingMusicCommands.size > 0 ||
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
    configurePlayerPanel();
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

function sendMusicControl(action: MusicControlAction): void {
  if (musicControlsDisabled()) return;
  const requestId = crypto.randomUUID();
  pendingMusicCommands.set(requestId, { action, expiresAt: Date.now() + MUSIC_COMMAND_ACK_TIMEOUT_MS });
  musicCommandError = "";
  render();
  musicCommandQueue = musicCommandQueue.then(async () => {
    if (!pendingMusicCommands.has(requestId)) return;
    if ((await OBR.player.getRole()) !== "GM" || musicControlsDisabled()) {
      pendingMusicCommands.delete(requestId);
      render();
      return;
    }
    latestMusicCommandIssuedAt = Math.max(Date.now(), latestMusicCommandIssuedAt + 1);
    const message = protocolMessage<MusicControlMessage>({
      kind: "MUSIC_CONTROL",
      requestId,
      issuedAt: latestMusicCommandIssuedAt,
      action,
    });
    await OBR.broadcast.sendMessage(BROADCAST_CHANNEL, message, { destination: "ALL" });
  }).catch((error: unknown) => {
    pendingMusicCommands.delete(requestId);
    musicCommandError = "Falha ao enviar o comando musical. Tente novamente.";
    render();
    console.error("[cinematic-sync] Falha ao enviar comando musical.", error);
  });
}

function expireMusicCommands(): boolean {
  const now = Date.now();
  let expired = false;
  for (const [requestId, command] of pendingMusicCommands) {
    if (now >= command.expiresAt) {
      pendingMusicCommands.delete(requestId);
      expired = true;
    }
  }
  if (expired) {
    musicCommandError = "Comando musical sem confirmação. Verifique o estado e tente novamente.";
    void requestMusicState().catch((error: unknown) => {
      console.error("[cinematic-sync] Falha ao recuperar estado musical.", error);
    });
  }
  return expired;
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
      pendingMusicCommands.size === 0 &&
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
        musicState?.mixVolumes,
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
  const [connectionId, playerId, name, role] = await Promise.all([
    OBR.player.getConnectionId(),
    OBR.player.getId(),
    OBR.player.getName(),
    OBR.player.getRole(),
  ]);
  localConnectionId = connectionId;
  localName = name;
  initializeLocalVolumeControls(playerId);

  if (role !== "GM") {
    configurePlayerPanel();
    document.body.classList.remove("booting");
    return;
  }
  initializeTrackControls();

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
      receiveMusicState(event.data.state, event.data.requestId);
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
      configurePlayerPanel();
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
  for (const button of emfButtons) {
    button.addEventListener("click", () => {
      const emf = EMFS.find(
        (candidate) => candidate.id === button.dataset.emfId,
      );
      if (!emf) return;
      sendMusicControl({ type: "PLAY_EMF", emfId: emf.id });
    });
  }

  await refreshParticipants();
  document.body.classList.remove("booting");
  await sendHello();
  await requestMusicState();
  renderMusic();
  window.setInterval(() => {
    if (expireMusicCommands()) render();
    else renderMusic();
  }, 250);
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
