import OBR from "@owlbear-rodeo/sdk";
import { importLocalAudio, isLocalSessionSource, LOCAL_SESSION_CHANNEL } from "./local-session-source";
import type { LocalSession, SessionStatus } from "./local-session";

type Snapshot = ReturnType<LocalSession["snapshot"]> & { canPlay: boolean };

// Called only after the GM role check. No import element exists in a PLAYER panel.
export function mountLocalSessionUi(connectionId: string, playerId: string,
  select: (sessionTrackId: string) => Promise<void>, readiness: (ready: boolean) => void): void {
  const section = document.createElement("section");
  section.dataset.gmOnly = "";
  section.className = "local-session-panel";
  section.innerHTML = `<h3>Faixa temporária <small>experimental</small></h3>
    <p class="secondary">Faixa temporária — armazenada apenas em cache. Pode ser removida pelo navegador.</p>
    <label>Importar áudio <input type="file" accept="audio/*,.ogg,.mp3" aria-label="Importar áudio temporário" /></label>
    <p class="local-session-name"></p><p class="local-session-status" role="status"></p>
    <button type="button" data-action="select" disabled>Usar faixa</button>
    <button type="button" data-action="retry">Distribuir / tentar novamente</button>
    <button type="button" data-action="cancel">Cancelar distribuição</button>
    <details><summary>Diagnóstico da POC</summary><pre></pre></details>`;
  document.querySelector(".music-panel")?.append(section);
  const input = section.querySelector("input")!;
  const label = section.querySelector<HTMLElement>(".local-session-name")!;
  const status = section.querySelector<HTMLElement>(".local-session-status")!;
  const diagnostics = section.querySelector("pre")!;
  const selectButton = section.querySelector<HTMLButtonElement>('[data-action="select"]')!;
  const retryButton = section.querySelector<HTMLButtonElement>('[data-action="retry"]')!;
  const cancelButton = section.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
  let snapshot: Snapshot | undefined;
  let importing = false;
  const send = async (kind: string): Promise<void> => {
    if (await OBR.player.getRole() !== "GM") return;
    await OBR.broadcast.sendMessage(LOCAL_SESSION_CHANNEL, { kind }, { destination: "LOCAL" });
  };
  const failure = (): void => { status.textContent = "Não foi possível concluir a operação. Tente novamente."; };
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file || importing) return;
    importing = true; input.disabled = true;
    status.textContent = "Validando áudio, SHA-256 e cache…";
    void (async () => {
      try {
        const source = await importLocalAudio(file, await OBR.player.getRole(), connectionId, playerId);
        if (await OBR.player.getRole() !== "GM") return;
        await OBR.broadcast.sendMessage(LOCAL_SESSION_CHANNEL, { kind: "IMPORT", source }, { destination: "LOCAL" });
        status.textContent = "Distribuição solicitada…";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Falha ao importar áudio.";
      } finally { importing = false; input.disabled = false; input.value = ""; }
    })();
  });
  retryButton.addEventListener("click", () => { void send("RETRY").catch(failure); });
  cancelButton.addEventListener("click", () => { void send("CANCEL").catch(failure); });
  selectButton.addEventListener("click", () => {
    if (snapshot?.source && snapshot.canPlay) void select(snapshot.source.sessionTrackId).catch(failure);
  });
  const unsubscribe = OBR.broadcast.onMessage(LOCAL_SESSION_CHANNEL, (event) => {
    if (event.connectionId !== connectionId || !event.data || typeof event.data !== "object") return;
    const value = event.data as Snapshot & { kind: string };
    if (value.kind !== "SNAPSHOT" || (value.source !== undefined && !isLocalSessionSource(value.source)) || !value.reports || typeof value.canPlay !== "boolean") return;
    snapshot = value;
    readiness(value.canPlay);
    selectButton.disabled = !value.canPlay;
    retryButton.disabled = value.distributing || !value.source;
    cancelButton.disabled = !value.distributing;
    input.disabled = importing || value.distributing;
    if (importing) return;
    label.textContent = value.source ? `${value.source.name} — Temporária` : "";
    const reports = Object.entries(value.reports);
    const ready = reports.filter(([, report]) => report.phase === "READY" && report.clockReady).length;
    status.textContent = value.canPlay ? "Pronta — use a faixa e os controles Play/Pause e seek acima." :
      value.source ? `${value.distributing ? "Distribuindo" : "Aguardando clientes"}… ${ready}/${reports.length} prontos` : "Escolha um OGG ou MP3 de até 100 MB.";
    void OBR.party.getPlayers().then((players) => {
      const names = new Map(players.map((peer) => [peer.connectionId, peer.name]));
      names.set(connectionId, "Você (GM)");
      const lines = reports.map(([id, report]: [string, SessionStatus]) => `${names.get(id) ?? "Cliente"}: ${report.phase} | ${report.bytes} bytes | cache ${report.cacheHit ? "hit" : "miss"} | clock ${report.clockReady ? "pronto" : "aguardando"}${report.error ? ` | ${report.error}` : ""}`);
      const errors = reports.filter(([, report]) => report.phase === "ERROR").map(([id, report]) => `${names.get(id) ?? "Cliente"}: ${report.error ?? "erro"}`);
      if (errors.length) status.textContent += ` — ${errors.join("; ")}`;
      diagnostics.textContent = [value.source ? `SHA-256: ${value.source.sha256}` : "", ...lines].join("\n");
    }).catch(() => {});
  });
  void send("SNAPSHOT_REQUEST").catch(failure);
  window.addEventListener("pagehide", () => unsubscribe(), { once: true });
}
