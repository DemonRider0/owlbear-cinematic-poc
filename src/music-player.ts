import {
  MUSIC_CINEMATIC_FADE_OUT_MS,
  MUSIC_DRIFT_TOLERANCE_SECONDS,
  MUSIC_GAIN_STEP_MS,
  MUSIC_PRELOAD_TIMEOUT_MS,
  MUSIC_TRACKS,
  getMusicTrackConfig,
  getMusicTrackRequestUrl,
  type MusicTrackId,
} from "./config";
import {
  musicPositionAtGm,
  normalizeMusicPosition,
  type MusicState,
} from "./music-state";

interface MusicClock {
  gmNow(): number;
  toLocalTime(gmTime: number, issuedAtGm: number): number;
}

interface TrackAudio {
  element: HTMLAudioElement;
  trackId: MusicTrackId;
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
  private readonly tracks = new Map<MusicTrackId, TrackAudio>();
  private readonly timers = new Set<Timer>();
  private appliedStateId: string | undefined;
  private currentState: MusicState | undefined;

  constructor(clock: MusicClock) {
    this.clock = clock;
    for (const config of MUSIC_TRACKS) {
      const element = new Audio();
      element.preload = "auto";
      element.loop = true;
      element.volume = 0;
      element.src = getMusicTrackRequestUrl(config.id);
      element.addEventListener("error", () => {
        console.error(
          `[cinematic-sync] Falha ao carregar a música ${config.label}.`,
          element.error,
        );
      });
      this.tracks.set(config.id, { element, trackId: config.id });
    }
  }

  async preload(): Promise<void> {
    await Promise.all(
      [...this.tracks.values()].map(async ({ element, trackId }) => {
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
            reject(new Error(`Falha no preload musical (${trackId}).`));
          };
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(
              new DOMException(
                `Preload musical excedeu ${MUSIC_PRELOAD_TIMEOUT_MS} ms (${trackId}).`,
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
    if (this.appliedStateId === state.stateId) {
      return;
    }
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
    if (
      state.transition &&
      gmNow < state.transition.startAtGm + state.transition.durationMs
    ) {
      return;
    }

    const track = this.requiredTrack(state.trackId);
    const expected = musicPositionAtGm(state, gmNow);
    if (track.element.paused) {
      this.startTrack(
        track,
        expected,
        this.gainForTrackAtGm(track.trackId, state, gmNow),
        false,
        () => {
          this.pauseAll([track.trackId]);
        },
      );
      return;
    }

    const duration = getMusicTrackConfig(state.trackId).durationSeconds;
    if (
      circularDistance(track.element.currentTime, expected, duration) >
      MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(track.element, expected);
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
        this.setPosition(
          this.requiredTrack(state.trackId).element,
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
      const latenessSeconds = Math.max(0, Date.now() - applyAtLocal) / 1_000;
      const position = normalizeMusicPosition(
        state.trackId,
        state.positionSeconds + latenessSeconds,
      );
      this.startExclusive(state.trackId, position, 1);
    });
  }

  private startManualCrossfade(
    state: MusicState,
    transitionStartLocal: number,
  ): void {
    const transition = state.transition;
    if (!transition) {
      return;
    }

    const now = Date.now();
    const elapsedSeconds = Math.max(0, now - transitionStartLocal) / 1_000;
    const progress = clamp01(
      (now - transitionStartLocal) / transition.durationMs,
    );
    const oldTrack = this.requiredTrack(transition.fromTrackId);
    const newTrack = this.requiredTrack(state.trackId);
    let newPlaybackStarted =
      !newTrack.element.paused && newTrack.element.readyState >= 3;
    let transitionCompleted = false;
    const completeSwap = (): void => {
      oldTrack.element.pause();
      oldTrack.element.volume = 0;
      newTrack.element.volume = 1;
    };
    this.pauseAll([oldTrack.trackId, newTrack.trackId]);
    this.startTrack(
      oldTrack,
      transition.fromPositionSeconds + elapsedSeconds,
      equalPowerOut(progress),
      true,
    );
    this.startTrack(
      newTrack,
      state.positionSeconds + elapsedSeconds,
      equalPowerIn(progress),
      false,
      () => {
        newPlaybackStarted = true;
        if (transitionCompleted) {
          completeSwap();
        }
      },
    );

    this.runAbsoluteRamp(
      transitionStartLocal,
      transition.durationMs,
      (nextProgress) => {
        oldTrack.element.volume = equalPowerOut(nextProgress);
        newTrack.element.volume = equalPowerIn(nextProgress);
      },
      () => {
        transitionCompleted = true;
        if (newPlaybackStarted) {
          completeSwap();
        } else {
          oldTrack.element.volume = 1;
          newTrack.element.volume = 0;
        }
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
    const audibleAtLocal = this.clock.toLocalTime(
      handoff.audibleAtGm,
      state.updatedAtGm,
    );
    this.fadeOutForCinematic(videoStartLocal);

    this.scheduleAt(videoStartLocal, () => {
      const now = Date.now();
      const position = normalizeMusicPosition(
        state.trackId,
        state.positionSeconds + Math.max(0, now - videoStartLocal) / 1_000,
      );
      this.startExclusive(state.trackId, position, 0);
      const track = this.requiredTrack(state.trackId);
      this.runAbsoluteRamp(
        audibleAtLocal,
        handoff.fadeInMs,
        (progress) => {
          track.element.volume = equalPowerIn(progress);
        },
        () => {
          track.element.volume = 1;
        },
      );
    });
  }

  private fadeOutForCinematic(videoStartLocal: number): void {
    const now = Date.now();
    const available = Math.max(0, videoStartLocal - now - 50);
    const duration = Math.min(MUSIC_CINEMATIC_FADE_OUT_MS, available);
    const playing = [...this.tracks.values()].filter(
      ({ element }) => !element.paused,
    );
    if (duration <= 0) {
      this.pauseAll();
      return;
    }

    const startingVolumes = new Map(
      playing.map((track) => [track.trackId, track.element.volume]),
    );
    this.runAbsoluteRamp(
      now,
      duration,
      (progress) => {
        for (const track of playing) {
          track.element.volume =
            (startingVolumes.get(track.trackId) ?? 0) * equalPowerOut(progress);
        }
      },
      () => {
        for (const track of playing) {
          track.element.pause();
          track.element.volume = 0;
        }
      },
    );
  }

  private startExclusive(
    trackId: MusicTrackId,
    positionSeconds: number,
    volume: number,
  ): void {
    this.pauseAll([trackId]);
    this.startTrack(
      this.requiredTrack(trackId),
      positionSeconds,
      volume,
      false,
    );
  }

  private startTrack(
    track: TrackAudio,
    positionSeconds: number,
    volume: number,
    preserveIfSynchronized: boolean,
    onPlaybackStarted?: () => void,
  ): void {
    const normalized = normalizeMusicPosition(track.trackId, positionSeconds);
    const duration = getMusicTrackConfig(track.trackId).durationSeconds;
    if (
      !preserveIfSynchronized ||
      track.element.paused ||
      circularDistance(track.element.currentTime, normalized, duration) >
        MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(track.element, normalized);
    }
    track.element.volume = clamp01(volume);
    if (track.element.paused) {
      void track.element
        .play()
        .then(() => {
          this.synchronizeStartedTrack(track);
          onPlaybackStarted?.();
        })
        .catch((error: unknown) => {
          console.error(
            `[cinematic-sync] Reprodução musical bloqueada (${track.trackId}).`,
            error,
          );
        });
    } else {
      this.synchronizeStartedTrack(track);
      onPlaybackStarted?.();
    }
  }

  private synchronizeStartedTrack(track: TrackAudio): void {
    const state = this.currentState;
    if (!state || state.stateId !== this.appliedStateId) {
      return;
    }
    const gmNow = this.clock.gmNow();
    const expected = this.positionForTrackAtGm(track.trackId, state, gmNow);
    if (expected === undefined) {
      return;
    }
    const duration = getMusicTrackConfig(track.trackId).durationSeconds;
    if (
      circularDistance(track.element.currentTime, expected, duration) >
      MUSIC_DRIFT_TOLERANCE_SECONDS
    ) {
      this.setPosition(track.element, expected);
    }
    track.element.volume = this.gainForTrackAtGm(track.trackId, state, gmNow);
  }

  private positionForTrackAtGm(
    trackId: MusicTrackId,
    state: MusicState,
    gmNow: number,
  ): number | undefined {
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

  private gainForTrackAtGm(
    trackId: MusicTrackId,
    state: MusicState,
    gmNow: number,
  ): number {
    if (state.mode === "CINEMATIC" && state.cinematic) {
      if (trackId !== state.trackId || gmNow < state.cinematic.audibleAtGm) {
        return 0;
      }
      return equalPowerIn(
        (gmNow - state.cinematic.audibleAtGm) / state.cinematic.fadeInMs,
      );
    }
    if (
      state.transition &&
      gmNow < state.transition.startAtGm + state.transition.durationMs
    ) {
      const progress =
        (gmNow - state.transition.startAtGm) / state.transition.durationMs;
      if (trackId === state.trackId) {
        return equalPowerIn(progress);
      }
      if (trackId === state.transition.fromTrackId) {
        return equalPowerOut(progress);
      }
    }
    return trackId === state.trackId ? 1 : 0;
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

  private pauseAll(except: MusicTrackId[] = []): void {
    const exceptions = new Set(except);
    for (const track of this.tracks.values()) {
      if (!exceptions.has(track.trackId)) {
        track.element.pause();
        track.element.volume = 0;
      }
    }
  }

  private requiredTrack(trackId: MusicTrackId): TrackAudio {
    const track = this.tracks.get(trackId);
    if (!track) {
      throw new Error(`Elemento de áudio ausente para ${trackId}.`);
    }
    return track;
  }

  private scheduleAt(localTime: number, callback: () => void): void {
    const delay = Math.max(0, localTime - Date.now());
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
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
  }
}
