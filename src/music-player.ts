import {
  EMFS,
  MUSIC_CINEMATIC_FADE_OUT_MS,
  MUSIC_DRIFT_TOLERANCE_SECONDS,
  MUSIC_GAIN_STEP_MS,
  MUSIC_LAYER_FADE_MS,
  MUSIC_PRELOAD_TIMEOUT_MS,
  MUSIC_TRACKS,
  getMusicLoop,
  getMusicLoopCycleSeconds,
  getMusicTrackConfig,
  getMusicTrackRequestUrl,
  getEmfRequestUrl,
  type EmfId,
  type MusicTrackId,
} from "./config";
import {
  compareMusicStates,
  emfPositionAtGm,
  musicGainAtGm,
  musicLayerFadeAtGm,
  musicLayerIsPlaying,
  musicLayerMixAtGm,
  musicLayerPositionAtGm,
  musicPositionAtGm,
  nextMusicLoopSeamAtGm,
  normalizeMusicMediaPosition,
  normalizeMusicPosition,
  type MusicLayer,
  type MusicState,
} from "./music-state";
import {
  DEFAULT_LOCAL_AUDIO_VOLUMES,
  normalizeLocalAudioVolumes,
  type LocalAudioVolumes,
} from "./local-audio-settings";
import { toSerializableError } from "./errors";
import type { MusicPlaybackStatus } from "./protocol";

interface MusicClock {
  gmNow(): number;
  toLocalTime(gmTime: number, issuedAtGm: number): number;
}

type VoiceSlot = 0 | 1;

interface TrackVoice {
  element: HTMLAudioElement;
  gain: number;
  playToken: number;
  slot: VoiceSlot;
  trackId: MusicTrackId;
}

interface TrackDeck {
  activeSlot: VoiceSlot;
  loopGeneration: number;
  loopInProgressUntilGm?: number;
  loopTimers: Set<Timer>;
  layerTimeline?: DeckTimeline;
  layerStarted?: boolean;
  heldFade?: { commandAtGm: number; resumeAtGm?: number; endAtGm?: number };
  trackGain: number;
  trackId: MusicTrackId;
  voices: [TrackVoice, TrackVoice];
}

interface EmfVoice {
  element: HTMLAudioElement;
  gain: number;
  id: EmfId;
  playToken: number;
}

interface DeckTimeline {
  anchorAtGm: number;
  positionSeconds: number;
  stateId: string;
  trackId: MusicTrackId;
  updatedAtGm: number;
  validUntilGm?: number;
  layered?: boolean;
}

type Timer = number;
interface MediaPlayback {
  status: Exclude<MusicPlaybackStatus, "IDLE">;
  pending?: Promise<void>;
}

const LAYER_GAIN_STEP_MS = 16;
const REPLACEMENT_GRACE_MS = 4_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function equalPowerIn(progress: number): number {
  return Math.sin(clamp01(progress) * Math.PI * 0.5);
}

function equalPowerOut(progress: number): number {
  return Math.cos(clamp01(progress) * Math.PI * 0.5);
}

function circularDistance(
  left: number,
  right: number,
  duration: number,
): number {
  const direct = Math.abs(left - right);
  return Math.min(direct, Math.max(0, duration - direct));
}

export class MusicPlayer {
  private readonly clock: MusicClock;
  private readonly emfs = new Map<EmfId, EmfVoice>();
  private readonly tracks = new Map<MusicTrackId, TrackDeck>();
  private readonly timers = new Set<Timer>();
  private localMusicVolume: number;
  private localEffectsVolume: number;
  private appliedStateId: string | undefined;
  private currentState: MusicState | undefined;
  private readonly pendingActivations = new Set<Timer>();
  private receivedState: MusicState | undefined;
  private completedEmfStateId: string | undefined;
  private mixTimer: Timer | undefined;
  private layerHeadroom = 1;
  private readonly mediaPlayback = new Map<HTMLAudioElement, MediaPlayback>();
  private reportedPlayback: MusicPlaybackStatus = "IDLE";
  private playbackReportPending = false;

  constructor(
    clock: MusicClock,
    initialVolumes: LocalAudioVolumes = DEFAULT_LOCAL_AUDIO_VOLUMES,
    private readonly onPlaybackChange?: (status: MusicPlaybackStatus) => void,
  ) {
    this.clock = clock;
    const normalizedVolumes = normalizeLocalAudioVolumes(initialVolumes);
    this.localMusicVolume = normalizedVolumes.musicVolume;
    this.localEffectsVolume = normalizedVolumes.effectsVolume;
    for (const { id, loop } of MUSIC_TRACKS) {
      if (!loop) this.requiredDeck(id);
    }
    for (const config of EMFS) {
      const element = new Audio();
      element.preload = "auto";
      element.loop = false;
      element.volume = this.localEffectsVolume;
      element.src = getEmfRequestUrl(config.id);
      element.addEventListener("pause", () => this.reportPlayback());
      element.addEventListener("error", () => {
        console.error(
          `[cinematic-sync] Falha ao carregar ${config.label}.`,
          element.error,
        );
      });
      this.emfs.set(config.id, {
        element,
        gain: 1,
        id: config.id,
        playToken: 0,
      });
    }
  }

  async preload(): Promise<void> {
    const candidates = [
      ...this.allVoices().filter(({ trackId }) => !getMusicTrackConfig(trackId).loop)
        .map(({ element, trackId, slot }) => ({
        description: `música ${trackId}, voz ${slot + 1}`,
        element,
      })),
      ...[...this.emfs.values()].map(({ element, id }) => ({
        description: id.toUpperCase().replace("-", " "),
        element,
      })),
    ];
    await Promise.all(
      candidates.map(async ({ description, element }) => {
        if (element.readyState >= 3) {
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            window.clearTimeout(timeout);
            element.removeEventListener("canplay", ready);
            element.removeEventListener("canplaythrough", ready);
            element.removeEventListener("error", failed);
          };
          const ready = (): void => {
            if (element.readyState >= 3) {
              cleanup();
              resolve();
            }
          };
          const failed = (): void => {
            cleanup();
            reject(
              new Error(`Falha no preload de áudio (${description}).`),
            );
          };
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(
              new DOMException(
                `Preload de áudio excedeu ${MUSIC_PRELOAD_TIMEOUT_MS} ms (${description}).`,
                "TimeoutError",
              ),
            );
          }, MUSIC_PRELOAD_TIMEOUT_MS);
          element.addEventListener("canplay", ready);
          element.addEventListener("canplaythrough", ready);
          element.addEventListener("error", failed, { once: true });
          element.load();
          ready();
        });
      }),
    );
  }

  applyState(state: MusicState): void {
    const previous = this.receivedState;
    if (previous && (previous.stateId === state.stateId || compareMusicStates(state, previous) <= 0)) {
      return;
    }
    this.receivedState = state;
    if (state.mode === "CINEMATIC" || (previous && previous.authorityConnectionId !== state.authorityConnectionId)) {
      for (const timer of this.pendingActivations) window.clearTimeout(timer);
      this.pendingActivations.clear();
    }
    if (state.mode === "MANUAL" && state.layers) {
      for (const layer of state.layers) {
        if (musicLayerIsPlaying(layer, Math.max(state.anchorAtGm, this.clock.gmNow()))) {
          this.requiredDeck(layer.trackId);
        }
      }
    }
    const activationAtLocal = this.clock.toLocalTime(
      state.anchorAtGm,
      state.updatedAtGm,
    );
    if (
      (state.mode === "MANUAL" || state.mode === "EMF") &&
      (this.currentState !== undefined || state.layers !== undefined) &&
      activationAtLocal > Date.now()
    ) {
      this.scheduleAt(activationAtLocal, () => {
        if (!this.currentState || compareMusicStates(state, this.currentState) > 0) {
          this.activateState(state);
        }
      }, this.pendingActivations);
      return;
    }
    this.activateState(state);
  }

  setLocalVolumes(volumes: LocalAudioVolumes): void {
    const normalized = normalizeLocalAudioVolumes(volumes);
    if (normalized.musicVolume !== this.localMusicVolume) {
      this.localMusicVolume = normalized.musicVolume;
      this.refreshMusicVolumes();
    }
    if (normalized.effectsVolume !== this.localEffectsVolume) {
      this.localEffectsVolume = normalized.effectsVolume;
      for (const voice of this.emfs.values()) {
        this.refreshEmfVolume(voice);
      }
    }
  }

  private activateState(state: MusicState): void {
    const previous = this.currentState;
    const wasLayered = previous?.mode === "MANUAL" && previous.layers !== undefined;
    const isLayered = state.mode === "MANUAL" && state.layers !== undefined;
    if (!isLayered || !wasLayered) {
      this.cancelAutomation();
    }
    if (wasLayered && !isLayered) {
      if (this.mixTimer !== undefined) window.clearTimeout(this.mixTimer);
      this.mixTimer = undefined;
      for (const deck of this.tracks.values()) {
        deck.trackGain *= this.layerHeadroom;
      }
      this.layerHeadroom = 1;
    }
    this.appliedStateId = state.stateId;
    this.currentState = state;

    if (state.mode === "CINEMATIC") {
      this.applyCinematicState(state);
    } else if (state.mode === "EMF") {
      if (previous?.mode !== "EMF" ||
        previous.emf?.startAtGm !== state.emf?.startAtGm || previous.emf?.id !== state.emf?.id) {
        this.applyEmfState(state);
      }
    } else if (state.layers) {
      this.applyLayeredState(state, state.layers);
    } else {
      this.applyManualState(state);
    }
  }

  retryAutoplay(): void {
    if (this.receivedState && this.reportedPlayback === "BLOCKED" &&
      [...this.mediaPlayback.keys()].some((element) => this.needsAutoplayRetry(element))) {
      this.reconcile(this.receivedState, true);
    }
  }

  private needsAutoplayRetry(element: HTMLAudioElement): boolean {
    const attempt = this.mediaPlayback.get(element);
    return attempt?.status === "BLOCKED" && attempt.pending === undefined;
  }

  reconcile(state: MusicState, retryBlocked = false): void {
    if (!this.currentState || state.stateId !== this.receivedState?.stateId) {
      return;
    }
    state = this.currentState;

    const gmNow = this.clock.gmNow();
    if (state.mode === "EMF") {
      this.reconcileEmf(state, gmNow);
      return;
    }
    if (state.mode === "MANUAL" && state.layers) {
      this.reconcileLayers(state, state.layers, gmNow, retryBlocked);
      return;
    }
    if (!state.playing) {
      return;
    }
    if (gmNow < state.anchorAtGm) {
      return;
    }
    if (state.mode === "CINEMATIC") {
      this.reconcileCinematic(state, gmNow);
      return;
    }
    if (
      state.transition &&
      gmNow < state.transition.startAtGm + state.transition.durationMs
    ) {
      if (retryBlocked && this.requiredDeck(state.trackId).voices.some(
        ({ element }) => this.needsAutoplayRetry(element),
      )) {
        this.cancelAutomation();
        this.applyManualState(state);
      }
      return;
    }

    const deck = this.requiredDeck(state.trackId);
    this.setTrackGain(deck, musicGainAtGm(state, gmNow));
    if (
      deck.loopInProgressUntilGm !== undefined &&
      gmNow < deck.loopInProgressUntilGm
    ) {
      return;
    }
    const voice = this.activeVoice(deck);
    const expected = musicPositionAtGm(state, gmNow);
    if (voice.element.paused) {
      this.startManualExclusive(state, true);
      return;
    }

    const cycleSeconds = getMusicLoopCycleSeconds(state.trackId);
    if (
      circularDistance(voice.element.currentTime, expected, cycleSeconds) >
      MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(voice.element, expected);
    }
  }

  private applyLayeredState(state: MusicState, layers: MusicLayer[]): void {
    this.pauseAllEmfs();
    if (this.mixTimer !== undefined) window.clearTimeout(this.mixTimer);
    this.updateLayerMix(state, layers);
    const now = this.clock.gmNow();
    for (const layer of layers) {
      if (!musicLayerIsPlaying(layer, now)) continue;
      const deck = this.requiredDeck(layer.trackId);
      const timeline = deck.layerTimeline;
      if (timeline?.positionSeconds === layer.positionSeconds &&
        timeline.anchorAtGm === layer.anchorAtGm) {
        continue;
      }
      // A new anchor inside an already-playing deck is a seek or a clock
      // takeover. A seek applies even if it changes the position by < 350 ms.
      const preserve = !timeline || layer.anchorAtGm !== state.anchorAtGm;
      this.startLayerTimeline(deck, layer, state, preserve);
    }
  }

  private startLayerTimeline(
    deck: TrackDeck,
    layer: MusicLayer,
    state: MusicState,
    preservePosition: boolean,
  ): void {
    this.clearDeckLoop(deck);
    const timeline: DeckTimeline = {
      stateId: state.stateId,
      updatedAtGm: state.updatedAtGm,
      trackId: layer.trackId,
      positionSeconds: layer.positionSeconds,
      anchorAtGm: layer.anchorAtGm,
      layered: true,
    };
    deck.layerTimeline = timeline;
    const voice = this.activeVoice(deck);
    this.pauseVoice(this.inactiveVoice(deck));
    if (!this.beginDeckLoopScheduling(deck, timeline)) {
      this.setVoiceGain(voice, 1);
      this.startVoice(
        voice, musicLayerPositionAtGm(layer, this.clock.gmNow()), preservePosition, true,
        () => { deck.layerStarted = true; },
      );
    } else {
      deck.layerStarted = true;
    }
  }

  private updateLayerMix(state: MusicState, layers: MusicLayer[]): void {
    this.mixTimer = undefined;
    const now = this.clock.gmNow();
    let nextTick = Number.POSITIVE_INFINITY;
    const byTrack = new Map(layers.map((layer) => [layer.trackId, layer]));
    const latest = this.receivedState;
    for (const deck of this.tracks.values()) {
      const layer = byTrack.get(deck.trackId);
      const delayed = layer && this.delayedReplacementFade(deck, layer, byTrack, now);
      if (!layer || (!delayed && !musicLayerIsPlaying(layer, now))) {
        const upcoming = latest && latest.stateId !== state.stateId &&
          latest.mode === "MANUAL" && latest.layers?.some((entry) =>
            entry.trackId === deck.trackId && musicLayerIsPlaying(entry, latest.anchorAtGm),
          );
        if (deck.layerTimeline || deck.voices.some(({ element }) => !element.paused) ||
          (!upcoming && getMusicTrackConfig(deck.trackId).loop)) {
          this.idleDeck(deck);
        }
        continue;
      }
      deck.trackGain = (delayed?.gain ?? musicLayerFadeAtGm(layer, now)) *
        musicLayerMixAtGm(state, layer, now);
      if (delayed) nextTick = Math.min(nextTick, delayed.remainingMs);
      for (const ramp of [layer.fade, layer.mixTransition]) {
        if (ramp && ramp.endAtGm > now) nextTick = Math.min(nextTick, ramp.endAtGm - now);
      }
    }
    this.refreshMusicVolumes();
    if (Number.isFinite(nextTick)) {
      this.mixTimer = window.setTimeout(
        () => this.updateLayerMix(state, layers),
        Math.min(LAYER_GAIN_STEP_MS, nextTick),
      );
    }
  }

  private delayedReplacementFade(
    deck: TrackDeck, layer: MusicLayer, byTrack: ReadonlyMap<MusicTrackId, MusicLayer>, now: number,
  ): { gain: number; remainingMs: number } | undefined {
    const { waitingForTrackId, fade } = layer;
    if (!waitingForTrackId || !fade) {
      deck.heldFade = undefined;
      return;
    }
    if (deck.heldFade?.commandAtGm !== fade.startAtGm) deck.heldFade = undefined;
    const target = byTrack.get(waitingForTrackId);
    const deadline = fade.endAtGm + REPLACEMENT_GRACE_MS;
    // Hold only an outgoing voice already audible here. Late joiners follow
    // the room envelope, and a missing asset never leaves a voice playing forever.
    if (target && musicLayerIsPlaying(target, now) &&
      !this.tracks.get(waitingForTrackId)?.layerStarted &&
      now < deadline && now < (deck.heldFade?.resumeAtGm ?? Number.POSITIVE_INFINITY) &&
      deck.voices.some(({ element }) => !element.paused) &&
      (now < fade.endAtGm || deck.heldFade)) {
      deck.heldFade ??= { commandAtGm: fade.startAtGm };
      return { gain: fade.fromGain, remainingMs: deadline - now };
    }
    if (!deck.heldFade) return;
    deck.heldFade.resumeAtGm ??= now;
    deck.heldFade.endAtGm ??= Math.max(fade.endAtGm, now + MUSIC_LAYER_FADE_MS);
    const { resumeAtGm, endAtGm } = deck.heldFade;
    if (now >= endAtGm) return;
    return {
      gain: fade.fromGain * equalPowerOut((now - resumeAtGm) / (endAtGm - resumeAtGm)),
      remainingMs: endAtGm - now,
    };
  }

  private reconcileLayers(
    state: MusicState, layers: MusicLayer[], gmNow: number, retryBlocked: boolean,
  ): void {
    for (const layer of layers) {
      if (!musicLayerIsPlaying(layer, gmNow)) continue;
      const deck = this.requiredDeck(layer.trackId);
      const voice = this.activeVoice(deck);
      if (retryBlocked) {
        if (deck.voices.some(({ element }) => this.needsAutoplayRetry(element))) {
          this.startLayerTimeline(deck, layer, state, true);
        }
        continue;
      }
      if (deck.loopInProgressUntilGm !== undefined && gmNow < deck.loopInProgressUntilGm) {
        continue;
      }
      if (voice.element.paused) {
        this.startLayerTimeline(deck, layer, state, false);
        continue;
      }
      const expected = musicLayerPositionAtGm(layer, gmNow);
      const drift = expected - voice.element.currentTime;
      if (Math.abs(drift) >= 1) {
        voice.element.playbackRate = 1;
        this.setPosition(voice.element, expected);
      } else {
        voice.element.playbackRate = Math.abs(drift) >= 0.15
          ? 1 + Math.sign(drift) * 0.03
          : 1;
      }
    }
  }

  private applyManualState(state: MusicState): void {
    const applyAtLocal = this.clock.toLocalTime(
      state.anchorAtGm,
      state.updatedAtGm,
    );

    if (!state.playing) {
      this.scheduleAt(applyAtLocal, () => {
        this.pauseAllEmfs();
        this.pauseAll();
        const deck = this.requiredDeck(state.trackId);
        this.setPosition(
          this.activeVoice(deck).element,
          state.positionSeconds,
        );
      });
      return;
    }

    if (state.transition) {
      const transitionStartLocal = this.clock.toLocalTime(
        state.transition.startAtGm,
        state.updatedAtGm,
      );
      const transitionEndLocal =
        transitionStartLocal + state.transition.durationMs;
      if (Date.now() < transitionEndLocal) {
        this.scheduleAt(transitionStartLocal, () => {
          this.startManualCrossfade(state, transitionStartLocal);
        });
        return;
      }
    }

    this.scheduleAt(applyAtLocal, () => {
      this.startManualExclusive(state, true);
    });
  }

  private startManualExclusive(
    state: MusicState,
    preserveIfSynchronized: boolean,
  ): void {
    if (state.stateId !== this.appliedStateId || !state.playing) {
      return;
    }
    const deck = this.requiredDeck(state.trackId);
    const voice = this.activeVoice(deck);
    const nowGm = this.clock.gmNow();
    this.pauseAllEmfs();
    this.pauseAllExceptDecks([deck]);
    this.pauseVoice(this.inactiveVoice(deck));
    this.setTrackGain(deck, musicGainAtGm(state, nowGm));
    this.setVoiceGain(voice, 1);
    this.startVoice(
      voice,
      musicPositionAtGm(state, nowGm),
      preserveIfSynchronized,
      true,
    );
    this.beginDeckLoopScheduling(deck, {
      anchorAtGm: state.anchorAtGm,
      positionSeconds: state.positionSeconds,
      stateId: state.stateId,
      trackId: state.trackId,
      updatedAtGm: state.updatedAtGm,
    });
    this.beginGainTransition(deck, state);
  }

  private beginGainTransition(
    deck: TrackDeck,
    state: MusicState,
  ): void {
    const transition = state.gainTransition;
    if (!transition || this.clock.gmNow() >= transition.endAtGm) {
      return;
    }
    const startAtLocal = this.clock.toLocalTime(
      transition.startAtGm,
      state.updatedAtGm,
    );
    if (Date.now() < startAtLocal) {
      this.scheduleAt(startAtLocal, () => {
        this.beginGainTransition(deck, state);
      });
      return;
    }
    this.runAbsoluteRamp(
      startAtLocal,
      transition.endAtGm - transition.startAtGm,
      () => {
        if (state.stateId === this.appliedStateId) {
          this.setTrackGain(
            deck,
            musicGainAtGm(state, this.clock.gmNow()),
          );
        }
      },
      () => {
        if (state.stateId === this.appliedStateId) {
          this.setTrackGain(deck, transition.toGain);
        }
      },
    );
  }

  private startManualCrossfade(
    state: MusicState,
    transitionStartLocal: number,
  ): void {
    const transition = state.transition;
    if (!transition || state.stateId !== this.appliedStateId) {
      return;
    }

    this.pauseAllEmfs();
    const nowGm = this.clock.gmNow();
    const progress = clamp01(
      (Date.now() - transitionStartLocal) / transition.durationMs,
    );
    const oldDeck = this.requiredDeck(transition.fromTrackId);
    const newDeck = this.requiredDeck(state.trackId);
    const oldVoice = this.activeVoice(oldDeck);
    const newVoice = this.activeVoice(newDeck);
    const outputGain = musicGainAtGm(state, nowGm);
    let newPlaybackStarted = this.mediaPlayback.get(newVoice.element)?.status === "PLAYING";
    let transitionCompleted = false;
    const completeSwap = (): void => {
      if (state.stateId !== this.appliedStateId) {
        return;
      }
      this.pauseDeck(oldDeck);
      this.setTrackGain(
        newDeck,
        musicGainAtGm(state, this.clock.gmNow()),
      );
    };
    const transitionEndsAtGm =
      transition.startAtGm + transition.durationMs;
    const oldTimeline: DeckTimeline = {
      anchorAtGm: transition.startAtGm,
      positionSeconds: transition.fromPositionSeconds,
      stateId: state.stateId,
      trackId: transition.fromTrackId,
      updatedAtGm: state.updatedAtGm,
      validUntilGm: transitionEndsAtGm,
    };
    const newTimeline: DeckTimeline = {
      anchorAtGm: state.anchorAtGm,
      positionSeconds: state.positionSeconds,
      stateId: state.stateId,
      trackId: state.trackId,
      updatedAtGm: state.updatedAtGm,
    };

    this.pauseAllExceptDecks([oldDeck, newDeck]);
    this.pauseVoice(this.inactiveVoice(oldDeck));
    this.pauseVoice(this.inactiveVoice(newDeck));
    this.setVoiceGain(oldVoice, 1);
    this.setVoiceGain(newVoice, 1);
    this.setTrackGain(oldDeck, outputGain * equalPowerOut(progress));
    this.setTrackGain(newDeck, outputGain * equalPowerIn(progress));
    this.startVoice(
      oldVoice,
      this.positionForTimeline(oldTimeline, nowGm),
      true,
      true,
    );
    this.startVoice(
      newVoice,
      this.positionForTimeline(newTimeline, nowGm),
      false,
      true,
      () => {
        newPlaybackStarted = true;
        if (transitionCompleted) {
          completeSwap();
        }
      },
    );
    this.beginDeckLoopScheduling(oldDeck, oldTimeline);
    this.beginDeckLoopScheduling(newDeck, newTimeline);

    this.runAbsoluteRamp(
      transitionStartLocal,
      transition.durationMs,
      (nextProgress) => {
        const currentOutputGain = musicGainAtGm(
          state,
          this.clock.gmNow(),
        );
        this.setTrackGain(
          oldDeck,
          currentOutputGain * equalPowerOut(nextProgress),
        );
        this.setTrackGain(
          newDeck,
          currentOutputGain * equalPowerIn(nextProgress),
        );
      },
      () => {
        transitionCompleted = true;
        if (newPlaybackStarted) {
          completeSwap();
        } else {
          this.setTrackGain(
            oldDeck,
            musicGainAtGm(state, this.clock.gmNow()),
          );
          this.setTrackGain(newDeck, 0);
        }
      },
    );
  }

  private beginDeckLoopScheduling(
    deck: TrackDeck,
    timeline: DeckTimeline,
  ): boolean {
    const generation = ++deck.loopGeneration;
    deck.loopInProgressUntilGm = undefined;
    const referenceGm = Math.max(this.clock.gmNow(), timeline.anchorAtGm);
    const position = this.positionForTimeline(timeline, referenceGm);
    const loop = getMusicLoop(deck.trackId);
    const phase = position - loop.startSeconds;
    const elapsedSinceAnchorSeconds =
      Math.max(0, referenceGm - timeline.anchorAtGm) / 1_000;
    const hasCrossedASeam = timeline.positionSeconds + elapsedSinceAnchorSeconds >= loop.seamSeconds ||
      (!timeline.layered && timeline.positionSeconds > Number.EPSILON);
    if (
      hasCrossedASeam &&
      phase >= (timeline.layered ? 0 : Number.EPSILON) &&
      phase < loop.crossfadeSeconds
    ) {
      const seamAtGm = referenceGm - phase * 1_000;
      const seamAtLocal = this.clock.toLocalTime(
        seamAtGm,
        timeline.updatedAtGm,
      );
      this.startDeckLoopCrossfade(
        deck,
        timeline,
        generation,
        seamAtGm,
        seamAtLocal,
        true,
      );
      return true;
    }
    this.scheduleNextDeckLoop(deck, timeline, generation);
    return false;
  }

  private isCurrentLoop(deck: TrackDeck, timeline: DeckTimeline, generation: number): boolean {
    return deck.loopGeneration === generation && (timeline.layered
      ? deck.layerTimeline === timeline
      : timeline.stateId === this.appliedStateId);
  }

  private scheduleNextDeckLoop(
    deck: TrackDeck,
    timeline: DeckTimeline,
    generation: number,
    requestedSeamAtGm?: number,
  ): void {
    if (!this.isCurrentLoop(deck, timeline, generation)) {
      return;
    }
    const referenceGm = Math.max(this.clock.gmNow(), timeline.anchorAtGm);
    const position = this.positionForTimeline(timeline, referenceGm);
    const seamAtGm =
      requestedSeamAtGm ??
      nextMusicLoopSeamAtGm(deck.trackId, position, referenceGm);
    if (
      timeline.validUntilGm !== undefined &&
      seamAtGm >= timeline.validUntilGm
    ) {
      return;
    }
    const seamAtLocal = this.clock.toLocalTime(
      seamAtGm,
      timeline.updatedAtGm,
    );
    this.scheduleAt(seamAtLocal, () => {
      this.startDeckLoopCrossfade(
        deck,
        timeline,
        generation,
        seamAtGm,
        seamAtLocal,
      );
    }, deck.loopTimers);
  }

  private startDeckLoopCrossfade(
    deck: TrackDeck,
    timeline: DeckTimeline,
    generation: number,
    seamAtGm: number,
    seamAtLocal: number,
    reconstructing = false,
  ): void {
    if (!this.isCurrentLoop(deck, timeline, generation)) {
      return;
    }
    const loop = getMusicLoop(deck.trackId);
    const overlapSeconds = loop.crossfadeSeconds;
    const overlapMs = overlapSeconds * 1_000;
    const elapsedSeconds = Math.max(0, this.clock.gmNow() - seamAtGm) / 1_000;
    const progress = clamp01(elapsedSeconds / overlapSeconds);
    if (progress >= 1) {
      const outgoing = this.activeVoice(deck);
      const incoming = this.inactiveVoice(deck);
      deck.activeSlot = incoming.slot;
      this.pauseVoice(outgoing);
      this.setVoiceGain(incoming, 1);
      this.startVoice(
        incoming,
        this.positionForTimeline(timeline, this.clock.gmNow()),
        false,
        true,
      );
      this.scheduleNextDeckLoop(deck, timeline, generation);
      return;
    }

    const outgoing = this.activeVoice(deck);
    const incoming = this.inactiveVoice(deck);
    let incomingPlaybackStarted = this.mediaPlayback.get(incoming.element)?.status === "PLAYING";
    let transitionCompleted = false;
    const completeSwap = (): void => {
      if (!this.isCurrentLoop(deck, timeline, generation)) {
        return;
      }
      deck.activeSlot = incoming.slot;
      this.pauseVoice(outgoing);
      this.setVoiceGain(incoming, 1);
    };
    deck.activeSlot = incoming.slot;
    deck.loopInProgressUntilGm = seamAtGm + overlapMs;
    this.setVoiceGain(outgoing, equalPowerOut(progress));
    this.setVoiceGain(incoming, equalPowerIn(progress));
    this.startVoice(
      outgoing,
      loop.seamSeconds + elapsedSeconds,
      !reconstructing,
      false,
    );
    this.startVoice(incoming, loop.startSeconds + elapsedSeconds, false, false, () => {
      if (!this.isCurrentLoop(deck, timeline, generation)) {
        return;
      }
      const currentProgress = clamp01(
        (Date.now() - seamAtLocal) / overlapMs,
      );
      incomingPlaybackStarted = true;
      this.setVoiceGain(incoming, equalPowerIn(currentProgress));
      if (transitionCompleted) {
        this.setPosition(
          incoming.element,
          this.positionForTimeline(timeline, this.clock.gmNow()),
        );
        completeSwap();
      }
    });

    this.runAbsoluteRamp(
      seamAtLocal,
      overlapMs,
      (nextProgress) => {
        this.setVoiceGain(outgoing, equalPowerOut(nextProgress));
        this.setVoiceGain(incoming, equalPowerIn(nextProgress));
      },
      () => {
        if (!this.isCurrentLoop(deck, timeline, generation)) {
          return;
        }
        transitionCompleted = true;
        if (incomingPlaybackStarted) {
          completeSwap();
        } else {
          deck.activeSlot = outgoing.slot;
          this.setVoiceGain(outgoing, 1);
          this.setVoiceGain(incoming, 0);
          this.startVoice(
            outgoing,
            this.positionForTimeline(timeline, this.clock.gmNow()),
            false,
            false,
          );
        }
        deck.loopInProgressUntilGm = undefined;
        this.scheduleNextDeckLoop(
          deck,
          timeline,
          generation,
          seamAtGm + getMusicLoopCycleSeconds(deck.trackId) * 1_000,
        );
      },
      deck.loopTimers,
    );
  }

  private applyEmfState(state: MusicState): void {
    const emf = state.emf;
    if (!emf) {
      return;
    }
    const startAtLocal = this.clock.toLocalTime(
      emf.startAtGm,
      state.updatedAtGm,
    );
    this.scheduleAt(startAtLocal, () => {
      this.startEmf(state);
    });
  }

  private startEmf(state: MusicState): void {
    const emf = state.emf;
    if (
      state.mode !== "EMF" ||
      !emf ||
      state.stateId !== this.appliedStateId
    ) {
      return;
    }

    this.pauseAll();
    this.pauseAllEmfs();
    this.completedEmfStateId = undefined;
    const position = emfPositionAtGm(state, this.clock.gmNow());
    if (position === undefined || position >= emf.durationSeconds) {
      return;
    }

    const voice = this.requiredEmf(emf.id);
    voice.element.loop = false;
    this.refreshEmfVolume(voice);
    this.setPosition(voice.element, position);
    const token = ++voice.playToken;
    voice.element.addEventListener(
      "ended",
      () => {
        if (
          voice.playToken === token &&
          state.stateId === this.appliedStateId
        ) {
          this.pauseEmf(voice);
          this.completedEmfStateId = state.stateId;
        }
      },
      { once: true },
    );
    this.playMedia(voice.element, emf.id, () => {
      if (
        voice.playToken !== token ||
        state.stateId !== this.appliedStateId
      ) {
        return;
      }
      const expected = emfPositionAtGm(state, this.clock.gmNow());
      if (
        expected !== undefined &&
        expected < emf.durationSeconds &&
        Math.abs(voice.element.currentTime - expected) >
          MUSIC_DRIFT_TOLERANCE_SECONDS
      ) {
        this.setPosition(voice.element, expected);
      }
    });
  }

  private reconcileEmf(state: MusicState, gmNow: number): void {
    const emf = state.emf;
    if (!emf || gmNow < emf.startAtGm) {
      return;
    }
    const position = emfPositionAtGm(state, gmNow);
    if (
      position === undefined ||
      position >= emf.durationSeconds ||
      this.completedEmfStateId === state.stateId
    ) {
      this.pauseAllEmfs();
      return;
    }

    const voice = this.requiredEmf(emf.id);
    if (voice.element.paused) {
      this.startEmf(state);
      return;
    }
    if (
      Math.abs(voice.element.currentTime - position) >
      MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(voice.element, position);
    }
  }

  private applyCinematicState(state: MusicState): void {
    const handoff = state.cinematic;
    if (!handoff) {
      return;
    }
    const videoStartLocal = this.clock.toLocalTime(
      handoff.videoStartAtGm,
      state.updatedAtGm,
    );
    this.fadeOutForCinematic(videoStartLocal);
    this.scheduleAt(videoStartLocal, () => {
      this.startCinematicTimeline(state);
    });
  }

  private startCinematicTimeline(state: MusicState): void {
    if (state.stateId !== this.appliedStateId || !state.cinematic) {
      return;
    }
    this.pauseAllEmfs();
    const outro = state.cinematic.outro;
    if (outro && this.clock.gmNow() >= outro.startAtGm) {
      this.startCinematicOutro(state);
      return;
    }
    this.startCinematicBridge(state);
  }

  private startCinematicBridge(state: MusicState): void {
    const handoff = state.cinematic;
    if (!handoff) {
      return;
    }
    this.pauseAll();
    if (handoff.outro) {
      const outroStartsAtLocal = this.clock.toLocalTime(
        handoff.outro.startAtGm,
        state.updatedAtGm,
      );
      this.scheduleAt(outroStartsAtLocal, () => {
        this.startCinematicOutro(state);
      });
    }
  }

  private startCinematicOutro(state: MusicState): void {
    const handoff = state.cinematic;
    const outro = handoff?.outro;
    if (!handoff || !outro || state.stateId !== this.appliedStateId) {
      return;
    }
    const nowGm = this.clock.gmNow();
    const progress = clamp01(
      (nowGm - outro.startAtGm) / outro.durationMs,
    );
    const newDeck = this.requiredDeck(outro.trackId);
    const newVoice = this.activeVoice(newDeck);
    const targetGain = outro.targetGain ?? 1;
    const newTimeline: DeckTimeline = {
      anchorAtGm: outro.startAtGm,
      positionSeconds: outro.positionSeconds,
      stateId: state.stateId,
      trackId: outro.trackId,
      updatedAtGm: state.updatedAtGm,
    };

    if (progress >= 1) {
      this.pauseAllExceptDecks([newDeck]);
      this.pauseVoice(this.inactiveVoice(newDeck));
      this.setVoiceGain(newVoice, 1);
      this.setTrackGain(newDeck, musicGainAtGm(state, nowGm));
      this.startVoice(
        newVoice,
        this.positionForTimeline(newTimeline, nowGm),
        true,
        false,
      );
      this.beginDeckLoopScheduling(newDeck, newTimeline);
      this.beginGainTransition(newDeck, state);
      return;
    }

    this.pauseAllExceptDecks([newDeck]);
    this.pauseVoice(this.inactiveVoice(newDeck));
    this.setVoiceGain(newVoice, 1);
    this.setTrackGain(newDeck, targetGain * equalPowerIn(progress));
    this.startVoice(
      newVoice,
      this.positionForTimeline(newTimeline, nowGm),
      false,
      false,
    );
    this.beginDeckLoopScheduling(newDeck, newTimeline);
    this.beginGainTransition(newDeck, state);

    const transitionStartLocal = this.clock.toLocalTime(
      outro.startAtGm,
      state.updatedAtGm,
    );
    this.runAbsoluteRamp(
      transitionStartLocal,
      outro.durationMs,
      (nextProgress) => {
        this.setTrackGain(
          newDeck,
          targetGain * equalPowerIn(nextProgress),
        );
      },
      () => {
        if (state.stateId !== this.appliedStateId) {
          return;
        }
        this.setTrackGain(newDeck, targetGain);
      },
    );
  }

  private reconcileCinematic(state: MusicState, gmNow: number): void {
    const handoff = state.cinematic;
    if (!handoff) {
      return;
    }
    const outro = handoff.outro;
    if (
      outro &&
      gmNow >= outro.startAtGm &&
      gmNow < outro.startAtGm + outro.durationMs
    ) {
      return;
    }
    if (outro && gmNow >= outro.startAtGm + outro.durationMs) {
      const deck = this.requiredDeck(outro.trackId);
      const voice = this.activeVoice(deck);
      this.setTrackGain(deck, musicGainAtGm(state, gmNow));
      const expected = normalizeMusicPosition(
        outro.trackId,
        outro.positionSeconds + (gmNow - outro.startAtGm) / 1_000,
      );
      if (voice.element.paused) {
        this.startCinematicOutro(state);
      } else if (
        circularDistance(
          voice.element.currentTime,
          expected,
          getMusicLoopCycleSeconds(outro.trackId),
        ) > MUSIC_DRIFT_TOLERANCE_SECONDS
      ) {
        this.setPosition(voice.element, expected);
      }
      return;
    }
  }

  private fadeOutForCinematic(videoStartLocal: number): void {
    const now = Date.now();
    const available = Math.max(0, videoStartLocal - now - 50);
    const duration = Math.min(MUSIC_CINEMATIC_FADE_OUT_MS, available);
    const playingDecks = [...this.tracks.values()].filter((deck) =>
      deck.voices.some(({ element }) => !element.paused),
    );
    if (duration <= 0) {
      this.pauseAll();
      return;
    }

    const startingGains = new Map(
      playingDecks.map((deck) => [deck.trackId, deck.trackGain]),
    );
    this.runAbsoluteRamp(
      now,
      duration,
      (progress) => {
        for (const deck of playingDecks) {
          this.setTrackGain(
            deck,
            (startingGains.get(deck.trackId) ?? 0) * equalPowerOut(progress),
          );
        }
      },
      () => {
        for (const deck of playingDecks) {
          this.pauseDeck(deck);
        }
      },
    );
  }

  private positionForTimeline(
    timeline: DeckTimeline,
    gmNow: number,
  ): number {
    return normalizeMusicPosition(
      timeline.trackId,
      timeline.positionSeconds +
        Math.max(0, gmNow - timeline.anchorAtGm) / 1_000,
    );
  }

  private startVoice(
    voice: TrackVoice,
    positionSeconds: number,
    preserveIfSynchronized: boolean,
    synchronizeOnStart: boolean,
    onPlaybackStarted?: () => void,
  ): void {
    const normalized = normalizeMusicMediaPosition(
      voice.trackId,
      positionSeconds,
    );
    const mediaDuration = getMusicTrackConfig(voice.trackId).durationSeconds;
    if (
      !preserveIfSynchronized ||
      voice.element.paused ||
      circularDistance(
        voice.element.currentTime,
        normalized,
        mediaDuration,
      ) > MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(voice.element, normalized);
    }
    this.refreshVoiceVolume(voice);
    const token = ++voice.playToken;
    this.playMedia(voice.element, `${voice.trackId}, voz ${voice.slot + 1}`, () => {
      if (voice.playToken !== token) return;
      if (synchronizeOnStart) {
        this.synchronizeStartedVoice(voice);
      }
      onPlaybackStarted?.();
    });
  }

  private playMedia(element: HTMLAudioElement, label: string, onStarted: () => void): void {
    const previous = this.mediaPlayback.get(element);
    if (!element.paused && previous?.status === "PLAYING") {
      onStarted();
      return;
    }
    if (previous?.pending) {
      void previous.pending.then(onStarted, () => undefined);
      return;
    }
    const attempt: MediaPlayback = { status: previous?.status === "BLOCKED" ? "BLOCKED" : "STARTING" };
    this.mediaPlayback.set(element, attempt);
    const pending = element.play();
    attempt.pending = pending;
    this.reportPlayback();
    void pending.then(() => {
      if (this.mediaPlayback.get(element) !== attempt) return;
      attempt.pending = undefined;
      attempt.status = "PLAYING";
      this.reportPlayback();
      onStarted();
    }, (error: unknown) => {
      if (this.mediaPlayback.get(element) !== attempt) return;
      attempt.pending = undefined;
      const blocked = toSerializableError(error).name === "NotAllowedError";
      attempt.status = blocked ? "BLOCKED" : "ERROR";
      if (!blocked || previous?.status !== "BLOCKED") {
        console.warn(`[cinematic-sync] Não foi possível iniciar ${label}.`, error);
      }
      this.reportPlayback();
    });
  }

  private pauseMedia(element: HTMLAudioElement): void {
    this.mediaPlayback.delete(element);
    element.pause();
    this.reportPlayback();
  }

  private reportPlayback(): void {
    if (this.playbackReportPending) return;
    this.playbackReportPending = true;
    queueMicrotask(() => {
      this.playbackReportPending = false;
      const statuses = new Set([...this.mediaPlayback].map(([element, attempt]) =>
        attempt.status === "PLAYING" && element.paused ? "IDLE" : attempt.status,
      ));
      const status = (["BLOCKED", "ERROR", "STARTING", "PLAYING"] as const)
        .find((candidate) => statuses.has(candidate)) ?? "IDLE";
      if (this.reportedPlayback !== status) {
        this.reportedPlayback = status;
        this.onPlaybackChange?.(status);
      }
    });
  }

  private synchronizeStartedVoice(voice: TrackVoice): void {
    const state = this.currentState;
    if (!state || state.stateId !== this.appliedStateId) {
      return;
    }
    const expected = this.positionForTrackAtGm(
      voice.trackId,
      state,
      this.clock.gmNow(),
    );
    if (expected === undefined) {
      return;
    }
    const duration = getMusicTrackConfig(voice.trackId).durationSeconds;
    if (
      circularDistance(voice.element.currentTime, expected, duration) >
      MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(voice.element, expected);
    }
  }

  private positionForTrackAtGm(
    trackId: MusicTrackId,
    state: MusicState,
    gmNow: number,
  ): number | undefined {
    if (state.mode === "MANUAL" && state.layers) {
      const layer = state.layers.find((entry) => entry.trackId === trackId);
      return layer && musicLayerIsPlaying(layer, gmNow)
        ? musicLayerPositionAtGm(layer, gmNow)
        : undefined;
    }
    if (state.mode === "CINEMATIC" && state.cinematic?.outro) {
      const outro = state.cinematic.outro;
      if (trackId === outro.trackId && gmNow >= outro.startAtGm) {
        return normalizeMusicPosition(
          trackId,
          outro.positionSeconds + (gmNow - outro.startAtGm) / 1_000,
        );
      }
      if (trackId === state.trackId) {
        return normalizeMusicMediaPosition(
          trackId,
          state.positionSeconds +
            Math.max(0, gmNow - state.anchorAtGm) / 1_000,
        );
      }
    }
    if (trackId === state.trackId) {
      return musicPositionAtGm(state, gmNow);
    }
    if (state.transition?.fromTrackId === trackId) {
      return normalizeMusicPosition(
        trackId,
        state.transition.fromPositionSeconds +
          Math.max(0, gmNow - state.transition.startAtGm) / 1_000,
      );
    }
    return undefined;
  }

  private setPosition(element: HTMLAudioElement, positionSeconds: number): void {
    try {
      element.currentTime = positionSeconds;
    } catch (error) {
      element.addEventListener(
        "loadedmetadata",
        () => {
          element.currentTime = positionSeconds;
        },
        { once: true },
      );
      console.warn(
        "[cinematic-sync] Seek musical adiado até loadedmetadata.",
        error,
      );
    }
  }

  private activeVoice(deck: TrackDeck): TrackVoice {
    return deck.voices[deck.activeSlot];
  }

  private inactiveVoice(deck: TrackDeck): TrackVoice {
    return deck.voices[deck.activeSlot === 0 ? 1 : 0];
  }

  private allVoices(): TrackVoice[] {
    return [...this.tracks.values()].flatMap((deck) => deck.voices);
  }

  private pauseEmf(voice: EmfVoice): void {
    voice.playToken += 1;
    this.pauseMedia(voice.element);
  }

  private pauseAllEmfs(): void {
    for (const voice of this.emfs.values()) {
      this.pauseEmf(voice);
    }
  }

  private pauseVoice(voice: TrackVoice): void {
    voice.playToken += 1;
    this.setVoiceGain(voice, 0);
    this.pauseMedia(voice.element);
    voice.element.playbackRate = 1;
  }

  private pauseDeck(deck: TrackDeck): void {
    this.clearDeckLoop(deck);
    deck.layerStarted = undefined;
    deck.heldFade = undefined;
    deck.trackGain = 0;
    for (const voice of deck.voices) {
      this.pauseVoice(voice);
    }
  }

  private clearDeckLoop(deck: TrackDeck): void {
    for (const timer of deck.loopTimers) window.clearTimeout(timer);
    deck.loopTimers.clear();
    deck.loopGeneration += 1;
    deck.loopInProgressUntilGm = undefined;
    deck.layerTimeline = undefined;
  }

  private idleDeck(deck: TrackDeck): void {
    this.pauseDeck(deck);
    if (getMusicTrackConfig(deck.trackId).loop) {
      for (const { element } of deck.voices) {
        element.removeAttribute("src");
        element.load();
      }
      this.tracks.delete(deck.trackId);
    }
  }

  private pauseAllExceptDecks(exceptions: TrackDeck[]): void {
    const allowed = new Set(exceptions);
    for (const deck of this.tracks.values()) {
      if (!allowed.has(deck)) {
        this.idleDeck(deck);
      }
    }
  }

  private pauseAll(): void {
    for (const deck of this.tracks.values()) {
      this.idleDeck(deck);
    }
  }

  private setTrackGain(deck: TrackDeck, gain: number): void {
    deck.trackGain = clamp01(gain);
    for (const voice of deck.voices) {
      this.refreshVoiceVolume(voice);
    }
  }

  private setVoiceGain(voice: TrackVoice, gain: number): void {
    voice.gain = clamp01(gain);
    if (this.currentState?.mode === "MANUAL" && this.currentState.layers) {
      this.refreshMusicVolumes();
    } else {
      this.refreshVoiceVolume(voice);
    }
  }

  private refreshMusicVolumes(): void {
    if (this.currentState?.mode === "MANUAL" && this.currentState.layers) {
      let combinedPeak = 0;
      for (const deck of this.tracks.values()) {
        const { peak } = getMusicTrackConfig(deck.trackId);
        const summedVoiceGain = deck.voices[0].gain + deck.voices[1].gain;
        combinedPeak += deck.trackGain * (peak ?? 1) * summedVoiceGain;
      }
      this.layerHeadroom = combinedPeak > 0.98 ? 0.98 / combinedPeak : 1;
    }
    for (const voice of this.allVoices()) this.refreshVoiceVolume(voice);
  }

  private refreshVoiceVolume(voice: TrackVoice): void {
    const deck = this.tracks.get(voice.trackId);
    voice.element.volume = clamp01(
      (deck?.trackGain ?? 0) * voice.gain * this.localMusicVolume * this.layerHeadroom,
    );
  }

  private refreshEmfVolume(voice: EmfVoice): void {
    voice.element.volume = clamp01(voice.gain * this.localEffectsVolume);
  }

  private requiredDeck(trackId: MusicTrackId): TrackDeck {
    const existing = this.tracks.get(trackId);
    if (existing) return existing;
    const config = getMusicTrackConfig(trackId);
    const createVoice = (slot: VoiceSlot): TrackVoice => {
      const element = new Audio();
      element.preload = "auto";
      element.loop = false;
      element.volume = 0;
      element.src = getMusicTrackRequestUrl(trackId);
      element.addEventListener("pause", () => this.reportPlayback());
      element.addEventListener("ended", () => this.reportPlayback());
      element.addEventListener("error", () => {
        if (element.getAttribute("src")) {
          console.error(
            `[cinematic-sync] Falha ao carregar a música ${config.label} (voz ${slot + 1}).`,
            element.error,
          );
        }
      });
      return { element, gain: 0, playToken: 0, slot, trackId };
    };
    const deck: TrackDeck = {
      activeSlot: 0,
      loopGeneration: 0,
      loopTimers: new Set(),
      trackGain: 0,
      trackId,
      voices: [createVoice(0), createVoice(1)],
    };
    this.tracks.set(trackId, deck);
    return deck;
  }

  private requiredEmf(emfId: EmfId): EmfVoice {
    const voice = this.emfs.get(emfId);
    if (!voice) {
      throw new Error(`Áudio ausente para ${emfId}.`);
    }
    return voice;
  }

  private scheduleAt(localTime: number, callback: () => void, timers = this.timers): void {
    const delay = Math.max(0, localTime - Date.now());
    if (delay === 0) {
      callback();
      return;
    }
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  }

  private runAbsoluteRamp(
    startAtLocal: number,
    durationMs: number,
    update: (progress: number) => void,
    complete: () => void,
    timers = this.timers,
  ): void {
    const tick = (): void => {
      const progress = clamp01((Date.now() - startAtLocal) / durationMs);
      update(progress);
      if (progress >= 1) {
        complete();
        return;
      }
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        tick();
      },
      Date.now() < startAtLocal
        ? startAtLocal - Date.now()
        : MUSIC_GAIN_STEP_MS);
      timers.add(timer);
    };
    tick();
  }

  private cancelAutomation(): void {
    for (const timer of this.timers) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
    for (const deck of this.tracks.values()) {
      this.clearDeckLoop(deck);
    }
  }
}
