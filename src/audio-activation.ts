import OBR from "@owlbear-rodeo/sdk";
import { AUDIO_ACTIVATION_CHANNEL } from "./config";

const button = document.querySelector<HTMLButtonElement>("#activate-audio");
const controls = document.querySelector<HTMLButtonElement>("#open-audio-controls");
const status = document.querySelector<HTMLElement>("#activation-status");

if (button && controls && status) {
  OBR.onReady(() => {
    button.disabled = false;
    controls.disabled = false;
    controls.addEventListener("click", () => {
      void OBR.broadcast.sendMessage(AUDIO_ACTIVATION_CHANNEL, "OPEN_CONTROLS", { destination: "LOCAL" })
        .catch((error: unknown) => {
          console.warn("[cinematic-sync] Não foi possível solicitar os controles.", error);
          status.textContent = "Não foi possível abrir os controles. Tente novamente.";
        });
    });
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      button.disabled = true;
      status.textContent = "Aguardando início da reprodução…";
      void OBR.broadcast.sendMessage(AUDIO_ACTIVATION_CHANNEL, "ACTIVATE", { destination: "LOCAL" })
        .then(() => {
          window.setTimeout(() => {
            status.textContent = "Se continuar sem áudio, confira as permissões de reprodução do navegador.";
            button.disabled = false;
          }, 3_000);
        })
        .catch((error: unknown) => {
          console.warn("[cinematic-sync] Não foi possível solicitar ativação de áudio.", error);
          status.textContent = "A solicitação falhou. Tente ativar novamente.";
          button.disabled = false;
        });
    });
  });
}
