import {
  MUSIC_CINEMATIC_FADE_OUT_MS,
  MUSIC_DRIFT_TOLERANCE_SECONDS,
  MUSIC_GAIN_STEP_MS,
  MUSIC_LOOP_CROSSFADE_MS,
  MUSIC_PRELOAD_TIMEOUT_MS,
  MUSIC_TRACKS,
  getMusicLoopCycleSeconds,
  getMusicTrackConfig,
  getMusicTrackRequestUrl,
  type MusicTrackId,
} from "./config";
import {
  musicPositionAtGm,
  nextMusicLoopSeamAtGm,
  normalizeMusicMediaPosition,
  normalizeMusicPosition,
  type CinematicMusicHandoff,
  type MusicState,
} from "./music-state";

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
  trackGain: number;
  trackId: MusicTrackId;
  voices: [TrackVoice, TrackVoice];
}

interface DeckTimeline {
  anchorAtGm: number;
  positionSeconds: number;
  stateId: string;
  trackId: MusicTrackId;
  updatedAtGm: number;
  validUntilGm?: number;
}

type Timer = number;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function equalPowerIn(progress: number): number {
  return Math.sin(clamp01(progress) * Math.PI * 0.5);
}

function equalPowerOut(progress: number): number {
  return Math.cos(clamp01(progress) * Math.PI * 0.5);
}

function smoothStep(progress: number): number {
  const clamped = clamp01(progress);
  return clamped * clamped * (3 - 2 * clamped);
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
  private readonly tracks = new Map<MusicTrackId, TrackDeck>();
  private readonly timers = new Set<Timer>();
  private appliedStateId: string | undefined;
  private currentState: MusicState | undefined;
  private pendingActivationTimer: Timer | undefined;
  private receivedStateId: string | undefined;

  constructor(clock: MusicClock) {
    this.clock = clock;
    for (const config of MUSIC_TRACKS) {
      const createVoice = (slot: VoiceSlot): TrackVoice => {
        const element = new Audio();
        element.preload = "auto";
        element.loop = false;
        element.volume = 0;
        element.src = getMusicTrackRequestUrl(config.id);
        element.addEventListener("error", () => {
          console.error(
            `[cinematic-sync] Falha ao carregar a música ${config.label} (voz ${slot + 1}).`,
            element.error,
          );
        });
        return {
          element,
          gain: 0,
          playToken: 0,
          slot,
          trackId: config.id,
        };
      };
      this.tracks.set(config.id, {
        activeSlot: 0,
        loopGeneration: 0,
        trackGain: 0,
        trackId: config.id,
        voices: [createVoice(0), createVoice(1)],
      });
    }
  }

  async preload(): Promise<void> {
    await Promise.all(
      this.allVoices().map(async (voice) => {
        const { element, trackId, slot } = voice;
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
              new Error(
                `Falha no preload musical (${trackId}, voz ${slot + 1}).`,
              ),
            );
          };
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(
              new DOMException(
                `Preload musical excedeu ${MUSIC_PRELOAD_TIMEOUT_MS} ms (${trackId}, voz ${slot + 1}).`,
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
    if (this.receivedStateId === state.stateId) {
      return;
    }
    this.receivedStateId = state.stateId;
    if (this.pendingActivationTimer !== undefined) {
      window.clearTimeout(this.pendingActivationTimer);
      this.pendingActivationTimer = undefined;
    }

    const activationAtLocal = this.clock.toLocalTime(
      state.anchorAtGm,
      state.updatedAtGm,
    );
    if (
      state.mode === "MANUAL" &&
      this.currentState !== undefined &&
      activationAtLocal > Date.now()
    ) {
      const expectedStateId = state.stateId;
      this.pendingActivationTimer = window.setTimeout(() => {
        this.pendingActivationTimer = undefined;
        if (this.receivedStateId === expectedStateId) {
          this.activateState(state);
        }
      }, activationAtLocal - Date.now());
      return;
    }
    this.activateState(state);
  }

  private activateState(state: MusicState): void {
    this.appliedStateId = state.stateId;
    this.currentState = state;
    this.cancelAutomation();

    if (state.mode === "CINEMATIC") {
      this.applyCinematicState(state);
    } else {
      this.applyManualState(state);
    }
  }

  reconcile(state: MusicState): void {
    if (!state.playing || state.stateId !== this.appliedStateId) {
      return;
    }

    const gmNow = this.clock.gmNow();
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
      return;
    }

    const deck = this.requiredDeck(state.trackId);
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

  private applyManualState(state: MusicState): void {
    const applyAtLocal = this.clock.toLocalTime(
      state.anchorAtGm,
      state.updatedAtGm,
    );

    if (!state.playing) {
      this.scheduleAt(applyAtLocal, () => {
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
    this.pauseAllExceptDecks([deck]);
    this.pauseVoice(this.inactiveVoice(deck));
    this.setTrackGain(deck, 1);
    this.setVoiceGain(voice, 1);
    this.startVoice(
      voice,
      musicPositionAtGm(state, this.clock.gmNow()),
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
  }

  private startManualCrossfade(
    state: MusicState,
    transitionStartLocal: number,
  ): void {
    const transition = state.transition;
    if (!transition || state.stateId !== this.appliedStateId) {
      return;
    }

    const nowGm = this.clock.gmNow();
    const progress = clamp01(
      (Date.now() - transitionStartLocal) / transition.durationMs,
    );
    const oldDeck = this.requiredDeck(transition.fromTrackId);
    const newDeck = this.requiredDeck(state.trackId);
    const oldVoice = this.activeVoice(oldDeck);
    const newVoice = this.activeVoice(newDeck);
    let newPlaybackStarted = !newVoice.element.paused;
    let transitionCompleted = false;
    const completeSwap = (): void => {
      if (state.stateId !== this.appliedStateId) {
        return;
      }
      this.pauseDeck(oldDeck);
      this.setTrackGain(newDeck, 1);
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
    this.setTrackGain(oldDeck, equalPowerOut(progress));
    this.setTrackGain(newDeck, equalPowerIn(progress));
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
        this.setTrackGain(oldDeck, equalPowerOut(nextProgress));
        this.setTrackGain(newDeck, equalPowerIn(nextProgress));
      },
      () => {
        transitionCompleted = true;
        if (newPlaybackStarted) {
          completeSwap();
        } else {
          this.setTrackGain(oldDeck, 1);
          this.setTrackGain(newDeck, 0);
        }
      },
    );
  }

  private beginDeckLoopScheduling(
    deck: TrackDeck,
    timeline: DeckTimeline,
  ): void {
    const generation = ++deck.loopGeneration;
    deck.loopInProgressUntilGm = undefined;
    const referenceGm = Math.max(this.clock.gmNow(), timeline.anchorAtGm);
    const position = this.positionForTimeline(timeline, referenceGm);
    const overlapSeconds = MUSIC_LOOP_CROSSFADE_MS / 1_000;
    const elapsedSinceAnchorSeconds =
      Math.max(0, referenceGm - timeline.anchorAtGm) / 1_000;
    const hasCrossedASeam =
      timeline.positionSeconds > Number.EPSILON ||
      timeline.positionSeconds + elapsedSinceAnchorSeconds >=
        getMusicLoopCycleSeconds(deck.trackId);
    if (
      hasCrossedASeam &&
      position > Number.EPSILON &&
      position < overlapSeconds
    ) {
      const seamAtGm = referenceGm - position * 1_000;
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
      return;
    }
    this.scheduleNextDeckLoop(deck, timeline, generation);
  }

  private scheduleNextDeckLoop(
    deck: TrackDeck,
    timeline: DeckTimeline,
    generation: number,
    requestedSeamAtGm?: number,
  ): void {
    if (
      deck.loopGeneration !== generation ||
      timeline.stateId !== this.appliedStateId
    ) {
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
    });
  }

  private startDeckLoopCrossfade(
    deck: TrackDeck,
    timeline: DeckTimeline,
    generation: number,
    seamAtGm: number,
    seamAtLocal: number,
    reconstructing = false,
  ): void {
    if (
      deck.loopGeneration !== generation ||
      timeline.stateId !== this.appliedStateId
    ) {
      return;
    }
    const overlapSeconds = MUSIC_LOOP_CROSSFADE_MS / 1_000;
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
    let incomingPlaybackStarted = !incoming.element.paused;
    let transitionCompleted = false;
    const completeSwap = (): void => {
      if (
        deck.loopGeneration !== generation ||
        timeline.stateId !== this.appliedStateId
      ) {
        return;
      }
      deck.activeSlot = incoming.slot;
      this.pauseVoice(outgoing);
      this.setVoiceGain(incoming, 1);
    };
    deck.activeSlot = incoming.slot;
    deck.loopInProgressUntilGm = seamAtGm + MUSIC_LOOP_CROSSFADE_MS;
    this.setVoiceGain(outgoing, equalPowerOut(progress));
    this.setVoiceGain(incoming, equalPowerIn(progress));
    this.startVoice(
      outgoing,
      getMusicLoopCycleSeconds(deck.trackId) + elapsedSeconds,
      !reconstructing,
      false,
    );
    this.startVoice(incoming, elapsedSeconds, false, false, () => {
      if (
        deck.loopGeneration !== generation ||
        timeline.stateId !== this.appliedStateId
      ) {
        return;
      }
      const currentProgress = clamp01(
        (Date.now() - seamAtLocal) / MUSIC_LOOP_CROSSFADE_MS,
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
      MUSIC_LOOP_CROSSFADE_MS,
      (nextProgress) => {
        this.setVoiceGain(outgoing, equalPowerOut(nextProgress));
        this.setVoiceGain(incoming, equalPowerIn(nextProgress));
      },
      () => {
        if (
          deck.loopGeneration !== generation ||
          timeline.stateId !== this.appliedStateId
        ) {
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
    );
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
    const deck = this.requiredDeck(state.trackId);
    const voice = this.activeVoice(deck);
    const nowGm = this.clock.gmNow();
    const position = normalizeMusicMediaPosition(
      state.trackId,
      state.positionSeconds +
        Math.max(0, nowGm - state.anchorAtGm) / 1_000,
    );
    this.pauseAllExceptDecks([deck]);
    this.pauseVoice(this.inactiveVoice(deck));
    this.setVoiceGain(voice, 1);
    this.setTrackGain(deck, this.cinematicBridgeGainAtGm(handoff, nowGm));
    this.startVoice(voice, position, false, false);

    const mediaDuration = getMusicTrackConfig(state.trackId).durationSeconds;
    const firstWrapAtGm =
      handoff.videoStartAtGm +
      (mediaDuration - state.positionSeconds) * 1_000;
    if (
      firstWrapAtGm > nowGm &&
      firstWrapAtGm < (handoff.outro?.startAtGm ?? handoff.videoEndsAtGm)
    ) {
      const wrapAtLocal = this.clock.toLocalTime(
        firstWrapAtGm,
        state.updatedAtGm,
      );
      this.scheduleAt(wrapAtLocal, () => {
        this.restartCinematicBridgeAtWrap(state, firstWrapAtGm);
      });
    }

    const bridgeEndsAtGm =
      handoff.outro?.startAtGm ?? handoff.videoEndsAtGm;
    const bridgeEndsAtLocal = this.clock.toLocalTime(
      bridgeEndsAtGm,
      state.updatedAtGm,
    );
    this.runUntil(bridgeEndsAtLocal, () => {
      if (state.stateId === this.appliedStateId) {
        this.setTrackGain(
          deck,
          this.cinematicBridgeGainAtGm(handoff, this.clock.gmNow()),
        );
      }
    });
    if (handoff.outro) {
      this.scheduleAt(bridgeEndsAtLocal, () => {
        this.startCinematicOutro(state);
      });
    }
  }

  private restartCinematicBridgeAtWrap(
    state: MusicState,
    wrapAtGm: number,
  ): void {
    const handoff = state.cinematic;
    if (!handoff || state.stateId !== this.appliedStateId) {
      return;
    }
    const deck = this.requiredDeck(state.trackId);
    const outgoing = this.activeVoice(deck);
    const incoming = this.inactiveVoice(deck);
    deck.activeSlot = incoming.slot;
    this.pauseVoice(outgoing);
    this.setVoiceGain(incoming, 1);
    this.startVoice(
      incoming,
      Math.max(0, this.clock.gmNow() - wrapAtGm) / 1_000,
      false,
      false,
    );
    this.setTrackGain(
      deck,
      this.cinematicBridgeGainAtGm(handoff, this.clock.gmNow()),
    );
  }

  private startCinematicOutro(state: MusicState): void {
    const handoff = state.cinematic;
    const outro = handoff?.outro;
    if (!handoff || !outro || state.stateId !== this.appliedStateId) {
      return;
    }
    const nowGm = this.clock.gmNow();
    const elapsedSeconds = Math.max(0, nowGm - outro.startAtGm) / 1_000;
    const progress = clamp01(
      (nowGm - outro.startAtGm) / outro.durationMs,
    );
    const oldDeck = this.requiredDeck(state.trackId);
    const newDeck = this.requiredDeck(outro.trackId);
    const oldVoice = this.activeVoice(oldDeck);
    const newVoice = this.activeVoice(newDeck);
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
      this.setTrackGain(newDeck, 1);
      this.startVoice(
        newVoice,
        this.positionForTimeline(newTimeline, nowGm),
        true,
        false,
      );
      this.beginDeckLoopScheduling(newDeck, newTimeline);
      return;
    }

    this.pauseAllExceptDecks([oldDeck, newDeck]);
    this.pauseVoice(this.inactiveVoice(oldDeck));
    this.pauseVoice(this.inactiveVoice(newDeck));
    this.setVoiceGain(oldVoice, 1);
    this.setVoiceGain(newVoice, 1);
    this.setTrackGain(oldDeck, equalPowerOut(progress));
    this.setTrackGain(newDeck, equalPowerIn(progress));
    this.startVoice(
      oldVoice,
      normalizeMusicMediaPosition(
        state.trackId,
        outro.fromPositionSeconds + elapsedSeconds,
      ),
      true,
      false,
    );
    this.startVoice(
      newVoice,
      this.positionForTimeline(newTimeline, nowGm),
      false,
      false,
    );
    this.beginDeckLoopScheduling(newDeck, newTimeline);

    const transitionStartLocal = this.clock.toLocalTime(
      outro.startAtGm,
      state.updatedAtGm,
    );
    this.runAbsoluteRamp(
      transitionStartLocal,
      outro.durationMs,
      (nextProgress) => {
        this.setTrackGain(oldDeck, equalPowerOut(nextProgress));
        this.setTrackGain(newDeck, equalPowerIn(nextProgress));
      },
      () => {
        if (state.stateId !== this.appliedStateId) {
          return;
        }
        this.pauseDeck(oldDeck);
        this.setTrackGain(newDeck, 1);
      },
    );
  }

  private cinematicBridgeGainAtGm(
    handoff: CinematicMusicHandoff,
    gmNow: number,
  ): number {
    if (gmNow < handoff.audibleAtGm) {
      return 0;
    }
    const embeddedMusicEndsAtGm =
      handoff.embeddedMusicEndsAtGm ??
      handoff.audibleAtGm + handoff.fadeInMs;
    const matchedGain = handoff.embeddedTrackGain ?? 1;
    if (gmNow < embeddedMusicEndsAtGm) {
      return (
        matchedGain *
        equalPowerIn(
          (gmNow - handoff.audibleAtGm) /
            (embeddedMusicEndsAtGm - handoff.audibleAtGm),
        )
      );
    }
    const normalizedAtGm =
      handoff.normalizedAtGm ?? embeddedMusicEndsAtGm;
    if (gmNow < normalizedAtGm) {
      return (
        matchedGain +
        (1 - matchedGain) *
          smoothStep(
            (gmNow - embeddedMusicEndsAtGm) /
              (normalizedAtGm - embeddedMusicEndsAtGm),
          )
      );
    }
    return 1;
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

    const deck = this.requiredDeck(state.trackId);
    const voice = this.activeVoice(deck);
    const expected = normalizeMusicMediaPosition(
      state.trackId,
      state.positionSeconds + (gmNow - state.anchorAtGm) / 1_000,
    );
    this.setTrackGain(deck, this.cinematicBridgeGainAtGm(handoff, gmNow));
    if (voice.element.paused) {
      this.startVoice(voice, expected, false, false);
    } else if (
      circularDistance(
        voice.element.currentTime,
        expected,
        getMusicTrackConfig(state.trackId).durationSeconds,
      ) > MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(voice.element, expected);
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
    if (voice.element.paused) {
      void voice.element
        .play()
        .then(() => {
          if (voice.playToken !== token) {
            return;
          }
          if (synchronizeOnStart) {
            this.synchronizeStartedVoice(voice);
          }
          onPlaybackStarted?.();
        })
        .catch((error: unknown) => {
          if (voice.playToken !== token) {
            return;
          }
          console.error(
            `[cinematic-sync] Reprodução musical bloqueada (${voice.trackId}, voz ${voice.slot + 1}).`,
            error,
          );
        });
    } else {
      if (synchronizeOnStart) {
        this.synchronizeStartedVoice(voice);
      }
      onPlaybackStarted?.();
    }
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

  private pauseVoice(voice: TrackVoice): void {
    voice.playToken += 1;
    voice.element.pause();
    voice.gain = 0;
    this.refreshVoiceVolume(voice);
  }

  private pauseDeck(deck: TrackDeck): void {
    deck.loopGeneration += 1;
    deck.loopInProgressUntilGm = undefined;
    deck.trackGain = 0;
    for (const voice of deck.voices) {
      this.pauseVoice(voice);
    }
  }

  private pauseAllExceptDecks(exceptions: TrackDeck[]): void {
    const allowed = new Set(exceptions);
    for (const deck of this.tracks.values()) {
      if (!allowed.has(deck)) {
        this.pauseDeck(deck);
      }
    }
  }

  private pauseAll(): void {
    for (const deck of this.tracks.values()) {
      this.pauseDeck(deck);
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
    this.refreshVoiceVolume(voice);
  }

  private refreshVoiceVolume(voice: TrackVoice): void {
    const deck = this.requiredDeck(voice.trackId);
    voice.element.volume = clamp01(deck.trackGain * voice.gain);
  }

  private requiredDeck(trackId: MusicTrackId): TrackDeck {
    const deck = this.tracks.get(trackId);
    if (!deck) {
      throw new Error(`Deck de áudio ausente para ${trackId}.`);
    }
    return deck;
  }

  private scheduleAt(localTime: number, callback: () => void): void {
    const delay = Math.max(0, localTime - Date.now());
    if (delay === 0) {
      callback();
      return;
    }
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
  }

  private runUntil(endAtLocal: number, update: () => void): void {
    const tick = (): void => {
      update();
      if (Date.now() >= endAtLocal) {
        return;
      }
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        tick();
      }, MUSIC_GAIN_STEP_MS);
      this.timers.add(timer);
    };
    tick();
  }

  private runAbsoluteRamp(
    startAtLocal: number,
    durationMs: number,
    update: (progress: number) => void,
    complete: () => void,
  ): void {
    const tick = (): void => {
      const progress = clamp01((Date.now() - startAtLocal) / durationMs);
      update(progress);
      if (progress >= 1) {
        complete();
        return;
      }
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        tick();
      },
      Date.now() < startAtLocal
        ? startAtLocal - Date.now()
        : MUSIC_GAIN_STEP_MS);
      this.timers.add(timer);
    };
    tick();
  }

  private cancelAutomation(): void {
    for (const timer of this.timers) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
    for (const deck of this.tracks.values()) {
      deck.loopGeneration += 1;
      deck.loopInProgressUntilGm = undefined;
    }
  }
}
