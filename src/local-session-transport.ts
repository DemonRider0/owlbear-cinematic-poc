import { MAX_LOCAL_AUDIO_BYTES } from "./local-session-source";

export const AUDIO_CHUNK_BYTES = 16 * 1024;
export const BUFFER_HIGH_BYTES = 256 * 1024;
export const BUFFER_LOW_BYTES = 64 * 1024;
const TRANSFER_TIMEOUT_MS = 120_000;

export interface RtcSignal {
  type: "offer" | "answer";
  sdp: string;
  transferId: string;
  sessionTrackId: string;
  target: string;
}

export function isRtcSignal(value: unknown): value is RtcSignal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every((key) => ["type", "sdp", "transferId", "sessionTrackId", "target"].includes(key)) &&
    (v.type === "offer" || v.type === "answer") && typeof v.sdp === "string" &&
    v.sdp.length > 0 && new TextEncoder().encode(JSON.stringify(v)).length < 15_000 &&
    [v.transferId, v.sessionTrackId, v.target].every((id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id));
}

export class ChunkReceiver {
  private parts: ArrayBuffer[] = [];
  bytes = 0;
  constructor(private readonly size: number) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_LOCAL_AUDIO_BYTES) throw new Error("Tamanho inválido.");
  }
  append(data: unknown): void {
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > AUDIO_CHUNK_BYTES || this.bytes + data.byteLength > this.size) {
      this.clear();
      throw new Error("Chunk inesperado ou limite excedido.");
    }
    this.parts.push(data);
    this.bytes += data.byteLength;
  }
  finish(mime: string): Blob {
    if (this.bytes !== this.size) {
      this.clear();
      throw new Error("Transferência incompleta.");
    }
    const blob = new Blob(this.parts, { type: mime });
    this.clear();
    return blob;
  }
  clear(): void { this.parts = []; this.bytes = 0; }
}

export async function waitForBuffer(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (channel.readyState !== "open") throw new Error("Canal RTC fechado.");
  if (channel.bufferedAmount <= BUFFER_HIGH_BYTES - AUDIO_CHUNK_BYTES) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      channel.removeEventListener("bufferedamountlow", drained);
      channel.removeEventListener("close", failed);
      channel.removeEventListener("error", failed);
      signal.removeEventListener("abort", failed);
      clearTimeout(timer);
    };
    const drained = (): void => { cleanup(); resolve(); };
    const failed = (): void => { cleanup(); reject(new Error("Transferência interrompida ou buffer bloqueado.")); };
    const timer = setTimeout(failed, 30_000);
    channel.addEventListener("bufferedamountlow", drained);
    channel.addEventListener("close", failed);
    channel.addEventListener("error", failed);
    signal.addEventListener("abort", failed);
    if (signal.aborted || channel.readyState !== "open") failed();
    else if (channel.bufferedAmount <= BUFFER_LOW_BYTES) drained();
  });
}

export async function sendChunks(channel: RTCDataChannel, blob: Blob, signal: AbortSignal,
  progress: (bytes: number) => void, maxMessageSize = AUDIO_CHUNK_BYTES): Promise<void> {
  channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;
  const chunkSize = Math.min(AUDIO_CHUNK_BYTES, maxMessageSize || AUDIO_CHUNK_BYTES);
  if (chunkSize < 1) throw new Error("RTC não negociou um tamanho de mensagem válido.");
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    await waitForBuffer(channel, signal);
    const chunk = await blob.slice(offset, offset + chunkSize).arrayBuffer();
    signal.throwIfAborted();
    channel.send(chunk);
    progress(Math.min(blob.size, offset + chunk.byteLength));
  }
  await waitForBuffer(channel, signal);
  channel.send("END");
}

interface Transfer {
  peer: string;
  id: string;
  trackId: string;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  receiver?: ChunkReceiver;
  resolve: (blob?: Blob) => void;
  reject: (error: Error) => void;
  mime: string;
  received: boolean;
}

// One bounded transfer per browser. GM distributes serially; no media enters signaling.
export class LocalSessionTransport {
  private active?: Transfer;
  constructor(private readonly signal: (message: RtcSignal) => Promise<void>,
    private readonly progress: (bytes: number) => void,
    private readonly createPeer = () => new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    })) {}

  cancel(): void { this.finish(new Error("Transferência cancelada.")); }

  private finish(error?: Error, blob?: Blob): void {
    const job = this.active;
    if (!job) return;
    this.active = undefined;
    clearTimeout(job.timer);
    job.controller.abort();
    job.receiver?.clear();
    job.pc.ondatachannel = null;
    job.pc.onconnectionstatechange = null;
    if (job.channel) {
      job.channel.onopen = null;
      job.channel.onmessage = null;
      job.channel.onerror = null;
      job.channel.onclose = null;
      job.channel.close();
    }
    job.pc.close();
    if (error) job.reject(error);
    else job.resolve(blob);
  }

  private begin(peer: string, id: string, trackId: string, mime: string, size?: number): Promise<Blob | undefined> {
    this.cancel();
    return new Promise((resolve, reject) => {
      const pc = this.createPeer();
      const job: Transfer = {
        peer, id, trackId, mime, pc, resolve, reject, received: false,
        controller: new AbortController(),
        timer: setTimeout(() => this.finish(new Error("RTC/transferência excedeu 120 s; tente novamente. A rede pode exigir TURN.")), TRANSFER_TIMEOUT_MS),
        receiver: size === undefined ? undefined : new ChunkReceiver(size),
      };
      this.active = job;
      pc.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState) && this.active === job) this.finish(new Error("Conexão RTC interrompida; tente novamente."));
      };
      pc.ondatachannel = (event) => {
        if (!job.receiver || job.channel || event.channel.label !== "local-session-audio") {
          event.channel.close();
          this.finish(new Error("Canal inesperado."));
          return;
        }
        this.bind(job, event.channel);
      };
    });
  }

  receive(peer: string, id: string, trackId: string, mime: string, size: number): Promise<Blob | undefined> {
    return this.begin(peer, id, trackId, mime, size);
  }

  async send(peer: string, id: string, trackId: string, blob: Blob): Promise<void> {
    const complete = this.begin(peer, id, trackId, blob.type);
    // Observe cancellation immediately, including during asynchronous ICE gathering.
    void complete.catch(() => {});
    const job = this.active;
    if (!job) return await complete.then(() => {});
    const channel = job.pc.createDataChannel("local-session-audio", { ordered: true });
    this.bind(job, channel);
    channel.onopen = () => {
      void sendChunks(channel, blob, job.controller.signal, this.progress, job.pc.sctp?.maxMessageSize)
        .catch((error: unknown) => { if (this.active === job) this.finish(asError(error)); });
    };
    try {
      await this.describe(job, await job.pc.createOffer());
    } catch (error) {
      if (this.active === job) this.finish(asError(error));
    }
    await complete;
  }

  private bind(job: Transfer, channel: RTCDataChannel): void {
    job.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onerror = () => { if (this.active === job) this.finish(new Error("Erro no DataChannel.")); };
    channel.onclose = () => {
      if (this.active === job) this.finish(job.received ? undefined : new Error("Canal fechado antes do fim."));
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (this.active !== job) return;
      try {
        if (job.receiver) {
          if (event.data === "END") {
            const blob = job.receiver.finish(job.mime);
            channel.send("RECEIVED");
            this.finish(undefined, blob);
          } else {
            job.receiver.append(event.data);
            this.progress(job.receiver.bytes);
          }
        } else if (event.data === "RECEIVED") {
          job.received = true;
          this.finish();
        } else throw new Error("Mensagem RTC inesperada.");
      } catch (error) { this.finish(asError(error)); }
    };
  }

  async handleSignal(sender: string, signal: RtcSignal): Promise<void> {
    const job = this.active;
    if (!job || sender !== job.peer || signal.transferId !== job.id || signal.sessionTrackId !== job.trackId) return;
    if ((job.receiver && signal.type !== "offer") || (!job.receiver && signal.type !== "answer") || job.pc.remoteDescription) return;
    try {
      await job.pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
      if (this.active !== job) return;
      if (signal.type === "offer") await this.describe(job, await job.pc.createAnswer());
    } catch (error) { if (this.active === job) this.finish(asError(error)); }
  }

  private async describe(job: Transfer, description: RTCSessionDescriptionInit): Promise<void> {
    await job.pc.setLocalDescription(description);
    // Non-trickle ICE keeps signaling small and removes candidate-order races.
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        job.pc.removeEventListener("icegatheringstatechange", check);
        job.controller.signal.removeEventListener("abort", aborted);
      };
      const check = (): void => { if (job.pc.iceGatheringState === "complete") { cleanup(); resolve(); } };
      const aborted = (): void => { cleanup(); reject(new Error("Negociação cancelada.")); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, 10_000);
      job.pc.addEventListener("icegatheringstatechange", check);
      job.controller.signal.addEventListener("abort", aborted);
      if (job.controller.signal.aborted) aborted();
      else check();
    });
    if (this.active !== job) return;
    const signal: RtcSignal = {
      type: description.type as "offer" | "answer", sdp: job.pc.localDescription?.sdp ?? "",
      target: job.peer, transferId: job.id, sessionTrackId: job.trackId,
    };
    if (!isRtcSignal(signal)) throw new Error("Signaling excede o limite seguro do Broadcast.");
    await this.signal(signal);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Falha no transporte RTC.");
}
