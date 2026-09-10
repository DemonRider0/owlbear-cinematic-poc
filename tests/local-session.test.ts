import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertGm, friendlyAudioName, importLocalAudio, isLocalSessionSource,
  LocalSessionCache, MAX_LOCAL_AUDIO_BYTES, probeAudio, sha256, validateAudioFile, verifyAudio,
  type LocalSessionSource,
} from "../src/local-session-source";
import {
  AUDIO_CHUNK_BYTES, BUFFER_HIGH_BYTES, BUFFER_LOW_BYTES, ChunkReceiver,
  isRtcSignal, LocalSessionTransport, sendChunks, waitForBuffer,
} from "../src/local-session-transport";
import { isSessionMessage, LocalSession, type LocalSessionDependencies, type SessionPeer } from "../src/local-session";

class AudioProbe extends EventTarget {
  readyState = 4;
  duration = 60;
  src = "";
  canPlayType(mime: string): string { return ["audio/ogg", "audio/mpeg"].includes(mime) ? "probably" : ""; }
  load(): void {}
  pause(): void {}
  removeAttribute(): void {}
}

class MemoryCache {
  entries = new Map<string, Response>();
  put = vi.fn(async (key: string, response: Response) => { this.entries.set(key, response.clone()); });
  match = vi.fn(async (key: string) => this.entries.get(key)?.clone());
  delete = vi.fn(async (key: string) => this.entries.delete(key));
}

function descriptor(hash: string, size: number): LocalSessionSource {
  return { kind: "LOCAL_SESSION", sessionTrackId: "session-1", name: "Faixa.ogg", size,
    mime: "audio/ogg", sha256: hash, durationSeconds: 60, ownerConnectionId: "gm", ownerPlayerId: "gm-player" };
}

let storage: MemoryCache;
beforeEach(() => {
  storage = new MemoryCache();
  vi.stubGlobal("caches", { open: async () => storage });
  vi.stubGlobal("Audio", AudioProbe);
  vi.stubGlobal("window", { location: { href: "https://example.test/extension/background.html" } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("LOCAL_SESSION validation and cache", () => {
  it("enforces GM before reading a file and strips Windows/Unix paths", async () => {
    expect(() => assertGm("PLAYER")).toThrow("Somente GM");
    await expect(importLocalAudio(new File(["abc"], "private.mp3"), "PLAYER", "p", "p")).rejects.toThrow("Somente GM");
    const source = await importLocalAudio(new File(["abc"], "C:\\Users\\GM\\music.ogg", { type: "audio/ogg" }), "GM", "gm", "gm-player");
    expect(source.name).toBe("music.ogg");
    expect(JSON.stringify(source)).not.toMatch(/Users|C:|\\\\/);
    expect(friendlyAudioName("/home/gm/music.ogg")).toBe("music.ogg");
    expect(isLocalSessionSource({ ...source, path: "private" })).toBe(false);
    expect(isLocalSessionSource({ ...source, name: "C:\\secret.mp3" })).toBe(false);
  });

  it("rejects oversized, empty and unsupported files using canPlayType", () => {
    expect(() => validateAudioFile({ size: MAX_LOCAL_AUDIO_BYTES + 1, type: "audio/mpeg" } as Blob, "track.mp3")).toThrow("100 MB");
    expect(() => validateAudioFile(new Blob([]), "a.mp3")).toThrow();
    expect(() => validateAudioFile(new Blob(["abc"], { type: "text/plain" }), "a.mp3")).toThrow("não reproduzível");
    expect(() => validateAudioFile(new Blob(["abc"], { type: "audio/unknown" }), "a.ogg")).toThrow();
    expect(validateAudioFile(new Blob(["abc"]), "a.mp3")).toBe("audio/mpeg");
    vi.spyOn(AudioProbe.prototype, "canPlayType").mockReturnValue("");
    expect(() => validateAudioFile(new Blob(["abc"]), "a.mp3")).toThrow();
  });

  it("rejects decoding failure even with a supported MIME and cleans the probe", async () => {
    vi.spyOn(AudioProbe.prototype, "load").mockImplementation(function (this: AudioProbe) {
      this.dispatchEvent(new Event("error"));
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await expect(probeAudio(new Blob(["bad"], { type: "audio/ogg" }))).rejects.toThrow("decodificar");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("calculates the known SHA-256 vector and rejects corruption before cache storage", async () => {
    const blob = new Blob(["abc"], { type: "audio/ogg" });
    const hash = await sha256(blob);
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const source = descriptor(hash, 3);
    await expect(verifyAudio(new Blob(["abd"]), source)).rejects.toThrow("SHA-256");
    await expect(new LocalSessionCache().put(source, new Blob(["abd"]))).rejects.toThrow();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("reuses one content key and purges a corrupt entry on reload", async () => {
    const blob = new Blob(["abc"], { type: "audio/ogg" });
    const source = descriptor(await sha256(blob), blob.size);
    const cache = new LocalSessionCache();
    await cache.put(source, blob);
    await cache.put({ ...source, sessionTrackId: "new-session", name: "Renamed.ogg" }, blob);
    expect(storage.put).toHaveBeenCalledOnce();
    expect([...storage.entries.keys()][0]).toContain(`/local-session/${source.sha256}`);
    expect(await (await new LocalSessionCache().get(source))?.text()).toBe("abc");
    const key = [...storage.entries.keys()][0]!;
    storage.entries.set(key, new Response("abd"));
    expect(await cache.get(source)).toBeUndefined();
    expect(storage.delete).toHaveBeenCalledWith(key);
  });
});

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: (ArrayBuffer | string)[] = [];
  send(data: ArrayBuffer | string): void {
    this.sent.push(data);
    this.bufferedAmount += typeof data === "string" ? data.length : data.byteLength;
  }
  drain(): void { this.bufferedAmount = 0; this.dispatchEvent(new Event("bufferedamountlow")); }
}

describe("chunk transfer and backpressure", () => {
  it("round-trips 32 MB in bounded chunks with matching SHA-256", async () => {
    const blob = new Blob([new Uint8Array(32_000_000).fill(73)], { type: "audio/ogg" });
    const receiver = new ChunkReceiver(blob.size);
    const channel = new Channel();
    channel.send = (data) => { if (data instanceof ArrayBuffer) receiver.append(data); };
    await sendChunks(channel as unknown as RTCDataChannel, blob, new AbortController().signal, () => {}, 8_192);
    expect(await sha256(receiver.finish("audio/ogg"))).toBe(await sha256(blob));
  });
  it("reassembles ordered chunks and rejects incomplete, excessive or unexpected data", async () => {
    const receiver = new ChunkReceiver(5);
    receiver.append(new Uint8Array([1, 2, 3]).buffer);
    receiver.append(new Uint8Array([4, 5]).buffer);
    expect([...new Uint8Array(await receiver.finish("audio/ogg").arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    expect(receiver.bytes).toBe(0);
    expect(() => new ChunkReceiver(5).finish("audio/ogg")).toThrow("incompleta");
    expect(() => new ChunkReceiver(5).append(new ArrayBuffer(6))).toThrow();
    expect(() => new ChunkReceiver(5).append("base64")).toThrow();
    expect(() => new ChunkReceiver(MAX_LOCAL_AUDIO_BYTES + 1)).toThrow();
  });

  it("stops at the high watermark and resumes only on drain, with bounded messages", async () => {
    const channel = new Channel();
    const blob = new Blob([new Uint8Array(600_000)]);
    const sent = sendChunks(channel as unknown as RTCDataChannel, blob, new AbortController().signal, () => {});
    await vi.waitFor(() => expect(channel.bufferedAmount).toBe(BUFFER_HIGH_BYTES));
    const count = channel.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.sent.length).toBe(count);
    expect(channel.bufferedAmountLowThreshold).toBe(BUFFER_LOW_BYTES);
    channel.drain();
    await vi.waitFor(() => expect(channel.bufferedAmount).toBe(BUFFER_HIGH_BYTES));
    channel.drain();
    await sent;
    expect(channel.sent.at(-1)).toBe("END");
    expect(channel.sent.filter((part) => typeof part !== "string").every((part) => part.byteLength <= AUDIO_CHUNK_BYTES)).toBe(true);
  });

  it("removes listeners and rejects on cancellation or channel close during backpressure", async () => {
    const channel = new Channel();
    channel.bufferedAmount = BUFFER_HIGH_BYTES;
    const remove = vi.spyOn(channel, "removeEventListener");
    const abort = new AbortController();
    const pending = waitForBuffer(channel as unknown as RTCDataChannel, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow("interrompida");
    expect(remove).toHaveBeenCalledWith("bufferedamountlow", expect.any(Function));
    const closed = waitForBuffer(channel as unknown as RTCDataChannel, new AbortController().signal);
    channel.dispatchEvent(new Event("close"));
    await expect(closed).rejects.toThrow();
  });

  it("admits only small signaling and forbids binary fields in Broadcast envelopes", () => {
    const signal = { type: "offer", sdp: "v=0", transferId: "t", sessionTrackId: "s", target: "p" };
    expect(isRtcSignal(signal)).toBe(true);
    expect(isRtcSignal({ ...signal, sdp: "a".repeat(16_000) })).toBe(false);
    expect(isRtcSignal({ ...signal, audio: "base64" })).toBe(false);
    expect(isSessionMessage({ kind: "RTC", signal, chunk: new ArrayBuffer(5) })).toBe(false);
    expect(isSessionMessage({ kind: "REGISTER", source: { blob: new Blob() } })).toBe(false);
  });
});

describe("RTC negotiation lifecycle", () => {
  class Peer extends EventTarget {
    remoteDescription?: RTCSessionDescriptionInit;
    localDescription?: RTCSessionDescriptionInit;
    iceGatheringState = "complete";
    connectionState = "new";
    ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    setRemoteDescription = vi.fn(async (value: RTCSessionDescriptionInit) => { this.remoteDescription = value; });
    setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => { this.localDescription = value; });
    createAnswer = vi.fn(async () => ({ type: "answer" as const, sdp: "v=0" }));
    close = vi.fn();
  }

  it("accepts only the expected peer/session/transfer and closes the connection on cancellation", async () => {
    const peer = new Peer(); const signal = vi.fn(async () => {});
    const transport = new LocalSessionTransport(signal, () => {}, () => peer as unknown as RTCPeerConnection);
    const pending = transport.receive("gm", "transfer", "track", "audio/ogg", 10);
    const offer = { type: "offer" as const, sdp: "v=0", target: "player", sessionTrackId: "track", transferId: "transfer" };
    await transport.handleSignal("attacker", offer);
    await transport.handleSignal("gm", { ...offer, transferId: "obsolete" });
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    await transport.handleSignal("gm", offer);
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith({ ...offer, type: "answer", target: "gm" });
    transport.cancel();
    await expect(pending).rejects.toThrow("cancelada");
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.ondatachannel).toBeNull();
    expect(peer.onconnectionstatechange).toBeNull();
  });

  it("times out an unreachable peer and discards partial transfer state", async () => {
    vi.useFakeTimers();
    const peer = new Peer();
    const transport = new LocalSessionTransport(async () => {}, () => {}, () => peer as unknown as RTCPeerConnection);
    const pending = transport.receive("gm", "transfer", "track", "audio/ogg", 10);
    const rejected = expect(pending).rejects.toThrow("120 s");
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(peer.close).toHaveBeenCalledOnce();
  });
});

describe("session readiness with connected clients", () => {
  it("honors ABORT while the initial CHECK is still preparing a cached file", async () => {
    const blob = new Blob(["abc"], { type: "audio/ogg" });
    const source = descriptor(await sha256(blob), blob.size);
    let release: (blob: Blob) => void = () => {};
    const cached = new Promise<Blob>((resolve) => { release = resolve; });
    const get = vi.fn(() => cached);
    const resolved = vi.fn(async () => {});
    const player = new LocalSession({
      identity: () => ({ connectionId: "player", name: "Player", role: "PLAYER" }),
      playerId: "player-id", peers: async () => [
        { connectionId: "gm", name: "GM", role: "GM" }, { connectionId: "player", name: "Player", role: "PLAYER" },
      ], send: async () => {}, persist: async () => {}, canImport: () => false,
      clockReady: () => true, resolved, changed: () => {},
    }, { get } as unknown as LocalSessionCache, () => ({ cancel: () => {} }) as unknown as LocalSessionTransport);
    const check = player.handle("gm", { kind: "CHECK", sessionTrackId: source.sessionTrackId, source, target: "player", attempt: "attempt-1" });
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    await player.handle("gm", { kind: "ABORT", sessionTrackId: source.sessionTrackId, target: "player", attempt: "attempt-1" });
    release(blob);
    await check;
    expect(player.snapshot().own.phase).toBe("ERROR");
    expect(resolved).not.toHaveBeenCalled();
    player.dispose();
  });

  async function room(corrupt = false) {
    const blob = new Blob(["audio content"], { type: "audio/ogg" });
    const source = descriptor(await sha256(blob), blob.size);
    const peers: SessionPeer[] = [{ connectionId: "gm", name: "GM", role: "GM" }, { connectionId: "player", name: "Player", role: "PLAYER" }];
    const sessions = new Map<string, LocalSession>();
    const copies = new Map<string, Blob>([["gm", blob]]);
    const incoming = new Map<string, (blob: Blob) => void>();
    const sends = vi.fn();
    const persist = vi.fn();
    const resolved = vi.fn(async () => {});
    const transfers = vi.fn();
    const writes = vi.fn();
    function create(id: string): LocalSession {
      const deps: LocalSessionDependencies = {
        identity: () => peers.find((peer) => peer.connectionId === id)!, playerId: id === "gm" ? "gm-player" : "player-id",
        peers: async () => peers, canImport: () => true, clockReady: () => true, persist,
        resolved, changed: () => {},
        send: async (message) => {
          sends(id, message);
          for (const client of sessions.values()) void client.handle(id, message);
        },
      };
      const cache = {
        get: async () => copies.get(id),
        put: async (_source: LocalSessionSource, data: Blob) => { writes(id); copies.set(id, data); return data; },
      } as LocalSessionCache;
      const transport = {
        cancel: () => {}, handleSignal: async () => {},
        receive: () => new Promise<Blob>((resolve) => { incoming.set(id, resolve); }),
        send: async (target: string, _transfer: string, _track: string, data: Blob) => {
          transfers(target);
          incoming.get(target)?.(corrupt ? new Blob(["wrong content"], { type: "audio/ogg" }) : data);
        },
      } as unknown as LocalSessionTransport;
      const client = new LocalSession(deps, cache, () => transport);
      sessions.set(id, client);
      return client;
    }
    const gm = create("gm"); const player = create("player");
    await gm.register(source); await player.register(source);
    return { gm, player, peers, create, source, sends, transfers, copies, writes, persist, sessions };
  }

  it("requests a missing asset, validates/caches it, gates READY, and skips retransmission on cache hits", async () => {
    const r = await room();
    expect(await r.gm.allReady()).toBe(false);
    await r.gm.distribute();
    expect(r.sends).toHaveBeenCalledWith("player", expect.objectContaining({ kind: "REQUEST" }));
    expect(await r.gm.allReady()).toBe(true);
    expect(r.transfers).toHaveBeenCalledOnce();
    expect(r.writes).toHaveBeenCalledOnce();
    await r.gm.distribute();
    expect(r.transfers).toHaveBeenCalledOnce();
    // Reload with the same cache and a new connection id: fresh readiness, no download.
    r.player.dispose(); r.sessions.delete("player");
    r.peers[1] = { connectionId: "reloaded", name: "Player", role: "PLAYER" };
    r.copies.set("reloaded", r.copies.get("player")!);
    r.create("reloaded");
    expect(await r.gm.allReady()).toBe(false);
    await r.gm.distribute();
    expect(await r.gm.allReady()).toBe(true);
    expect(r.transfers).toHaveBeenCalledOnce();
  });

  it("rejects a wrong hash before READY or writing the cache", async () => {
    const r = await room(true);
    await r.gm.distribute();
    expect(await r.gm.allReady()).toBe(false);
    expect(r.player.snapshot().own.phase).toBe("ERROR");
    expect(r.writes).not.toHaveBeenCalled();
  });

  it("recovers the GM readiness on manual retry after a playback error", async () => {
    const r = await room();
    await r.gm.distribute();
    r.gm.playbackFailed();
    expect(await r.gm.allReady()).toBe(false);
    await r.gm.distribute();
    expect(r.gm.snapshot().own.phase).toBe("READY");
    expect(await r.gm.allReady()).toBe(true);
    expect(r.transfers).toHaveBeenCalledOnce();
  });

  it("keeps seeding late clients from resolved memory after the GM cache is evicted", async () => {
    const r = await room();
    await r.gm.distribute();
    r.copies.delete("gm");
    r.gm.playbackFailed();
    r.peers.push({ connectionId: "late", name: "Late", role: "PLAYER" });
    r.create("late");
    await r.gm.distribute();
    expect(r.gm.snapshot().own.phase).toBe("READY");
    expect(await r.gm.allReady()).toBe(true);
    expect(r.transfers).toHaveBeenCalledWith("late");
    expect(r.writes).not.toHaveBeenCalledWith("gm");
    expect(r.gm.hasResolved(r.source)).toBe(true);
    for (const client of r.sessions.values()) client.dispose();
  });

  it("requires a new late participant and refuses PLAYER registration/import/control", async () => {
    const r = await room();
    await r.gm.distribute();
    r.peers.push({ connectionId: "late", name: "Late", role: "PLAYER" });
    r.create("late");
    expect(await r.gm.allReady()).toBe(false);
    await r.gm.handle("player", { kind: "IMPORT", source: r.source });
    await r.gm.handle("player", { kind: "REGISTER", source: { ...r.source, sessionTrackId: "forged" } });
    await r.gm.handle("player", { kind: "CANCEL" });
    expect(r.persist).not.toHaveBeenCalled();
    expect(r.gm.source?.sessionTrackId).toBe(r.source.sessionTrackId);
    await r.gm.distribute();
    expect(await r.gm.allReady()).toBe(true);
    expect(r.transfers).toHaveBeenCalledWith("late");
    for (const client of r.sessions.values()) client.dispose();
  });
});
