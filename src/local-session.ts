import {
  assertGm, isLocalSessionSource, LocalSessionCache, probeAudio, verifyAudio,
  type LocalSessionSource,
} from "./local-session-source";
import { isRtcSignal, LocalSessionTransport, type RtcSignal } from "./local-session-transport";

export interface SessionPeer { connectionId: string; name: string; role: "GM" | "PLAYER" }
export interface SessionStatus {
  phase: "CHECKING" | "MISSING" | "TRANSFERRING" | "READY" | "ERROR";
  bytes: number;
  cacheHit: boolean;
  clockReady: boolean;
  error?: string;
}
type Message =
  | { kind: "HELLO" }
  | { kind: "REGISTER"; source: LocalSessionSource }
  | { kind: "IMPORT"; source: LocalSessionSource }
  | { kind: "RETRY" }
  | { kind: "CANCEL" }
  | { kind: "CHECK"; sessionTrackId: string; target: string; attempt: string; source: LocalSessionSource }
  | { kind: "ABORT"; sessionTrackId: string; target: string; attempt: string }
  | { kind: "STATUS"; sessionTrackId: string; attempt: string; status: SessionStatus }
  | { kind: "REQUEST"; sessionTrackId: string; attempt: string; transferId: string; target: string }
  | { kind: "RTC"; signal: RtcSignal };

export interface LocalSessionDependencies {
  identity(): SessionPeer;
  playerId: string;
  peers(): Promise<SessionPeer[]>;
  send(message: unknown, local?: boolean): Promise<void>;
  persist(source: LocalSessionSource): Promise<void>;
  canImport(): boolean;
  clockReady(ownerConnectionId: string): boolean;
  resolved(source: LocalSessionSource, blob: Blob): Promise<void>;
  changed(): void;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,128}$/.test(value);
}

export function isSessionMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(v)).length >= 15_500) return false;
  const keys: Record<string, string[]> = {
    HELLO: [], REGISTER: ["source"], IMPORT: ["source"], RETRY: [], CANCEL: [],
    CHECK: ["sessionTrackId", "target", "attempt", "source"], ABORT: ["sessionTrackId", "target", "attempt"], STATUS: ["sessionTrackId", "attempt", "status"],
    REQUEST: ["sessionTrackId", "attempt", "transferId", "target"], RTC: ["signal"],
  };
  const allowed = keys[String(v.kind)];
  if (!allowed || Object.keys(v).some((key) => key !== "kind" && !allowed.includes(key))) return false;
  switch (v.kind) {
    case "HELLO": case "RETRY": case "CANCEL": return true;
    case "REGISTER": case "IMPORT": return isLocalSessionSource(v.source);
    case "RTC": return isRtcSignal(v.signal);
    case "CHECK": return isId(v.sessionTrackId) && isId(v.target) && isId(v.attempt) &&
      isLocalSessionSource(v.source) && v.source.sessionTrackId === v.sessionTrackId;
    case "ABORT": return isId(v.sessionTrackId) && isId(v.target) && isId(v.attempt);
    case "REQUEST": return isId(v.sessionTrackId) && isId(v.target) && isId(v.attempt) && isId(v.transferId);
    case "STATUS": {
      if (!isId(v.sessionTrackId) || !isId(v.attempt) || !v.status || typeof v.status !== "object") return false;
      const s = v.status as Record<string, unknown>;
      return Object.keys(s).every((key) => ["phase", "bytes", "cacheHit", "clockReady", "error"].includes(key)) &&
        ["CHECKING", "MISSING", "TRANSFERRING", "READY", "ERROR"].includes(String(s.phase)) &&
        Number.isSafeInteger(s.bytes) && Number(s.bytes) >= 0 && Number(s.bytes) <= 100 * 1024 * 1024 &&
        typeof s.cacheHit === "boolean" && typeof s.clockReady === "boolean" &&
        (s.error === undefined || (typeof s.error === "string" && s.error.length <= 200 && !/[\\/]/.test(s.error)));
    }
    default: return false;
  }
}

export class LocalSession {
  source?: LocalSessionSource;
  private readonly transport: LocalSessionTransport;
  private readonly reports = new Map<string, { status: SessionStatus; at: number; attempt: string }>();
  private readonly attempts = new Map<string, string>();
  private readonly requested = new Set<string>();
  private ownStatus: SessionStatus = { phase: "CHECKING", bytes: 0, cacheHit: false, clockReady: false };
  private ownAttempt = "initial";
  private resolvedBlob?: Blob;
  private preparing: Promise<void> = Promise.resolve();
  private distributing = false;
  private generation = 0;
  private lastProgressAt = 0;
  private disposed = false;
  private activeRecipient?: string;

  constructor(private readonly deps: LocalSessionDependencies,
    private readonly cache = new LocalSessionCache(),
    transportFactory = (send: (signal: RtcSignal) => Promise<void>, progress: (bytes: number) => void) => new LocalSessionTransport(send, progress)) {
    this.transport = transportFactory((signal) => deps.send({ kind: "RTC", signal }), (bytes) => {
      if (this.isOwner()) return;
      this.ownStatus = { ...this.ownStatus, phase: "TRANSFERRING", bytes };
      if (Date.now() - this.lastProgressAt > 500) {
        this.lastProgressAt = Date.now();
        void this.report().catch(() => {});
      }
    });
  }

  private isOwner(): boolean {
    return this.deps.identity().role === "GM" && this.source?.ownerConnectionId === this.deps.identity().connectionId;
  }

  hasResolved(source: LocalSessionSource): boolean {
    return this.source?.sessionTrackId === source.sessionTrackId && this.source.sha256 === source.sha256 && !!this.resolvedBlob;
  }

  async allReady(): Promise<boolean> {
    const source = this.source;
    const generation = this.generation;
    if (!this.isOwner() || !this.resolvedBlob || this.distributing) return false;
    const peers = await this.deps.peers();
    if (source !== this.source || generation !== this.generation || this.disposed || !this.isOwner() || this.distributing) return false;
    return peers.length > 0 && peers.every((peer) => {
      if (peer.connectionId === this.deps.identity().connectionId) return this.ownStatus.phase === "READY";
      const report = this.reports.get(peer.connectionId);
      return report && Date.now() - report.at < 15_000 && report.attempt === this.attempts.get(peer.connectionId) &&
        report.status.phase === "READY" && report.status.clockReady;
    });
  }

  snapshot(): { source?: LocalSessionSource; own: SessionStatus; reports: Record<string, SessionStatus>; distributing: boolean } {
    return { source: this.source, own: this.ownStatus, reports: Object.fromEntries(
      [...this.reports].map(([id, report]) => [id, Date.now() - report.at < 15_000 ? report.status : { ...report.status, phase: "MISSING" as const }]),
    ), distributing: this.distributing };
  }

  async register(source: LocalSessionSource): Promise<void> {
    if (this.disposed || !isLocalSessionSource(source)) return;
    if (this.source?.sessionTrackId === source.sessionTrackId && this.source.ownerConnectionId === source.ownerConnectionId) return;
    this.transport.cancel();
    this.generation++;
    this.source = source;
    this.resolvedBlob = undefined;
    this.reports.clear(); this.attempts.clear(); this.requested.clear();
    this.ownStatus = { phase: "CHECKING", bytes: 0, cacheHit: false, clockReady: false };
    this.deps.changed();
    await this.prepare(source);
  }

  private prepare(source: LocalSessionSource, incoming?: Blob, reuseResolved = false): Promise<void> {
    const generation = this.generation;
    const work = this.preparing.then(async () => {
      if (generation !== this.generation || this.disposed) return;
      try {
        let blob = incoming ?? await this.cache.get(source);
        if (blob) {
          await verifyAudio(blob, source);
          await probeAudio(blob);
          if (generation !== this.generation || this.disposed) return;
          if (incoming && !reuseResolved) blob = await this.cache.put(source, blob);
          if (generation !== this.generation || this.disposed) return;
          this.resolvedBlob = blob;
          await this.deps.resolved(source, blob);
          if (generation !== this.generation || this.disposed) return;
          this.ownStatus = { phase: "READY", bytes: source.size, cacheHit: !incoming || reuseResolved, clockReady: false };
        } else {
          this.resolvedBlob = undefined;
          this.ownStatus = { phase: "MISSING", bytes: 0, cacheHit: false, clockReady: false };
        }
      } catch {
        if (generation !== this.generation) return;
        this.resolvedBlob = undefined;
        this.ownStatus = { phase: "ERROR", bytes: 0, cacheHit: false, clockReady: false,
          error: "Falha de integridade, formato ou cache. Tente novamente." };
      }
      if (generation === this.generation) await this.report();
    });
    this.preparing = work.catch(() => {});
    return work;
  }

  async report(): Promise<void> {
    const source = this.source;
    if (!source || this.disposed) return;
    this.ownStatus.clockReady = this.deps.clockReady(source.ownerConnectionId);
    this.reports.set(this.deps.identity().connectionId, { status: { ...this.ownStatus }, at: Date.now(), attempt: this.ownAttempt });
    await this.deps.send({ kind: "STATUS", sessionTrackId: source.sessionTrackId, attempt: this.ownAttempt, status: this.ownStatus });
    this.deps.changed();
  }

  async tick(): Promise<void> {
    if (this.disposed) return;
    await this.report();
    if (!this.source) await this.deps.send({ kind: "HELLO" });
    if (this.isOwner()) {
      const ids = new Set((await this.deps.peers()).map((peer) => peer.connectionId));
      for (const id of this.reports.keys()) if (!ids.has(id)) {
        this.reports.delete(id); this.attempts.delete(id);
      }
      if (this.activeRecipient && !ids.has(this.activeRecipient)) this.transport.cancel();
      for (const id of ids) if (!this.reports.has(id)) this.reports.set(id, {
        at: Date.now(), attempt: "initial", status: { phase: "MISSING", bytes: 0, cacheHit: false, clockReady: false },
      });
    }
  }

  async distribute(): Promise<void> {
    assertGm(this.deps.identity().role);
    if (!this.isOwner() || this.distributing || !this.source) return;
    const source = this.source;
    const generation = this.generation;
    this.distributing = true;
    this.deps.changed();
    try {
      // A previously cache-verified Blob is still a valid session seed after eviction.
      // Retry must recheck integrity/decoding without discarding that in-memory copy.
      await this.prepare(source, this.resolvedBlob, true);
      if (!this.resolvedBlob) throw new Error("GM sem cópia íntegra no cache; importe novamente.");
      await this.deps.send({ kind: "REGISTER", source });
      for (const peer of await this.deps.peers()) {
        if (generation !== this.generation || this.disposed || !this.isOwner()) break;
        if (peer.connectionId === this.deps.identity().connectionId) continue;
        const previous = this.reports.get(peer.connectionId);
        if (previous?.status.phase === "READY" && Date.now() - previous.at < 15_000 && previous.attempt === this.attempts.get(peer.connectionId)) continue;
        const attempt = crypto.randomUUID();
        this.activeRecipient = peer.connectionId;
        this.attempts.set(peer.connectionId, attempt);
        this.reports.delete(peer.connectionId);
        await this.deps.send({ kind: "CHECK", sessionTrackId: source.sessionTrackId, target: peer.connectionId, attempt, source });
        const deadline = Date.now() + 150_000;
        // Simple serial distribution; CHECK -> cache hit READY or REQUEST -> RTC -> READY.
        while (generation === this.generation && !this.disposed && Date.now() < deadline) {
          const report = this.reports.get(peer.connectionId);
          if (report?.attempt === attempt && ["READY", "ERROR"].includes(report.status.phase)) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (generation !== this.generation || this.disposed) break;
        const report = this.reports.get(peer.connectionId);
        if (!report || !["READY", "ERROR"].includes(report.status.phase)) {
          this.reports.set(peer.connectionId, { at: Date.now(), attempt,
            status: { phase: "ERROR", bytes: report?.status.bytes ?? 0, cacheHit: false, clockReady: false,
              error: "Cliente não concluiu a transferência; tente novamente." } });
        }
      }
    } catch (error) {
      this.ownStatus = { ...this.ownStatus, phase: "ERROR", error: error instanceof Error ? error.message : "Falha na distribuição." };
    } finally {
      this.distributing = false;
      this.activeRecipient = undefined;
      this.requested.clear();
      this.deps.changed();
    }
  }

  async handle(sender: string, value: unknown): Promise<void> {
    if (this.disposed || !isSessionMessage(value)) return;
    const message = value;
    const peers = await this.deps.peers();
    const peer = peers.find((candidate) => candidate.connectionId === sender);
    if (!peer) return;
    const self = this.deps.identity();
    if (message.kind === "IMPORT") {
      if (sender !== self.connectionId || self.role !== "GM" || !this.deps.canImport() ||
        message.source.ownerConnectionId !== sender || message.source.ownerPlayerId !== this.deps.playerId || this.distributing) return;
      await this.register(message.source);
      if (!this.resolvedBlob) return;
      await this.deps.persist(message.source);
      await this.distribute();
      return;
    }
    if (message.kind === "REGISTER") {
      if (peer.role !== "GM" || message.source.ownerConnectionId !== sender) return;
      await this.register(message.source);
      return;
    }
    if (message.kind === "HELLO") {
      if (this.isOwner() && this.source) await this.deps.send({ kind: "REGISTER", source: this.source });
      return;
    }
    if (message.kind === "CANCEL" || message.kind === "RETRY") {
      if (sender !== self.connectionId || self.role !== "GM") return;
      if (message.kind === "RETRY") await this.distribute();
      else {
        const target = this.activeRecipient;
        const attempt = target ? this.attempts.get(target) : undefined;
        this.generation++; this.transport.cancel();
        this.activeRecipient = undefined;
        if (target && attempt && this.source) {
          this.attempts.delete(target);
          this.reports.set(target, { at: Date.now(), attempt: "cancelled", status: {
            phase: "ERROR", bytes: 0, cacheHit: false, clockReady: false, error: "Distribuição cancelada; tente novamente.",
          } });
          await this.deps.send({ kind: "ABORT", target, attempt, sessionTrackId: this.source.sessionTrackId });
        }
        this.deps.changed();
      }
      return;
    }
    if (message.kind === "CHECK") {
      if (message.target !== self.connectionId || peer.role !== "GM" || message.source.ownerConnectionId !== sender) return;
      if (this.ownAttempt === message.attempt) return;
      this.ownAttempt = message.attempt;
      // CHECK is self-contained: asynchronous roster lookups may reorder REGISTER/CHECK handlers.
      await this.register(message.source);
    }
    const source = this.source;
    if (!source) return;
    if (message.kind === "RTC") {
      if (message.signal.target !== self.connectionId || message.signal.sessionTrackId !== source.sessionTrackId) return;
      if (!this.isOwner() && (sender !== source.ownerConnectionId || peer.role !== "GM")) return;
      await this.transport.handleSignal(sender, message.signal);
      return;
    }
    if (message.sessionTrackId !== source.sessionTrackId) return;
    if (message.kind === "STATUS") {
      if (this.isOwner() && this.attempts.get(sender) === message.attempt && message.status.bytes <= source.size) {
        if (message.status.phase === "READY" && message.status.bytes !== source.size) return;
        this.reports.set(sender, { at: Date.now(), attempt: message.attempt, status: message.status });
        this.deps.changed();
      }
      return;
    }
    if (message.target !== self.connectionId) return;
    if (message.kind === "ABORT") {
      if (sender !== source.ownerConnectionId || peer.role !== "GM" || this.ownAttempt !== message.attempt) return;
      this.generation++; this.transport.cancel();
      this.ownAttempt = "cancelled";
      this.ownStatus = { ...this.ownStatus, phase: "ERROR", error: "Distribuição cancelada pelo GM; tente novamente." };
      await this.report();
      return;
    }
    if (message.kind === "CHECK") {
      if (sender !== source.ownerConnectionId || peer.role !== "GM" || this.isOwner() || this.ownAttempt !== message.attempt) return;
      this.transport.cancel();
      this.ownAttempt = message.attempt;
      const generation = this.generation;
      await this.prepare(source);
      if (generation !== this.generation || this.ownAttempt !== message.attempt || this.ownStatus.phase === "READY" || this.ownStatus.phase === "ERROR") return;
      const transferId = crypto.randomUUID();
      const received = this.transport.receive(sender, transferId, source.sessionTrackId, source.mime, source.size);
      void received.catch(() => {});
      try {
        this.ownStatus.phase = "TRANSFERRING";
        await this.deps.send({ kind: "REQUEST", sessionTrackId: source.sessionTrackId, target: sender, attempt: message.attempt, transferId });
        const blob = await received;
        if (generation !== this.generation || this.ownAttempt !== message.attempt || !blob) return;
        await this.prepare(source, blob);
      } catch {
        if (generation !== this.generation || this.ownAttempt !== message.attempt) return;
        this.ownStatus = { ...this.ownStatus, phase: "ERROR", error: "RTC interrompido, indisponível ou tempo excedido. Tente novamente." };
        await this.report();
      }
    } else if (message.kind === "REQUEST") {
      if (!this.isOwner() || !this.distributing || this.activeRecipient !== sender || !this.resolvedBlob || this.attempts.get(sender) !== message.attempt || this.requested.has(message.attempt)) return;
      this.requested.add(message.attempt);
      try { await this.transport.send(sender, message.transferId, source.sessionTrackId, this.resolvedBlob); }
      catch {
        this.reports.set(sender, { at: Date.now(), attempt: message.attempt,
          status: { phase: "ERROR", bytes: 0, cacheHit: false, clockReady: false, error: "Falha RTC; tente novamente. A rede pode exigir TURN." } });
        this.deps.changed();
      }
    }
  }

  dispose(): void {
    this.disposed = true; this.generation++; this.transport.cancel();
    this.resolvedBlob = undefined; this.reports.clear(); this.attempts.clear(); this.requested.clear();
  }

  async reconnect(): Promise<void> {
    const previous = this.source;
    this.dispose();
    this.disposed = false;
    this.source = undefined;
    this.ownAttempt = "initial";
    if (previous) {
      const self = this.deps.identity();
      const source = self.role === "GM" && previous.ownerPlayerId === this.deps.playerId
        ? { ...previous, ownerConnectionId: self.connectionId } : previous;
      if ((await this.deps.peers()).some((peer) => peer.connectionId === source.ownerConnectionId && peer.role === "GM")) {
        await this.register(source);
        if (this.isOwner()) {
          await this.deps.persist(source);
          await this.deps.send({ kind: "REGISTER", source });
        }
      }
    }
    await this.deps.send({ kind: "HELLO" });
  }

  playbackFailed(): void {
    this.ownStatus = { ...this.ownStatus, phase: "ERROR", error: "Navegador bloqueou a reprodução ou falhou ao decodificar. Tente novamente." };
    void this.report().catch(() => {});
  }
}
