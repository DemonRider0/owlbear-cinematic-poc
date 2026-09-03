import OBR from "@owlbear-rodeo/sdk";

type DiagnosticValue = boolean | number | string;

const diagnostics: Record<string, DiagnosticValue> = {
  navigationStartedAt: Math.round(performance.timeOrigin),
  sdkImportedAt: Date.now(),
  documentReadyStateAtSdkImport: document.readyState,
  isAvailableAfterImport: OBR.isAvailable,
  isReadyBeforeOnReady: OBR.isReady,
};

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      diagnostics.documentLoadedAt = Date.now();
    },
    { once: true },
  );
} else {
  diagnostics.documentLoadedAt = Date.now();
}

function diagnosticPanelUrl(): string {
  const url = new URL("./panel.html", window.location.href);
  for (const [key, value] of Object.entries(diagnostics)) {
    url.searchParams.set(key, String(value));
  }
  return url.href;
}

diagnostics.onReadyRegisteredAt = Date.now();

OBR.onReady(() => {
  diagnostics.onReadyCalledAt = Date.now();
  diagnostics.isReadyInCallback = OBR.isReady;

  void OBR.tool
    .create({
      id: "dev.cinematic-sync.handshake-diagnostic/tool",
      icons: [
        {
          icon: new URL("../icon.svg", window.location.href).href,
          label: "Handshake SDK OK",
        },
      ],
      async onClick(_context, elementId) {
        await OBR.popover.open({
          id: "dev.cinematic-sync.handshake-diagnostic/panel",
          url: diagnosticPanelUrl(),
          width: 420,
          height: 360,
          anchorElementId: elementId,
          anchorOrigin: { horizontal: "LEFT", vertical: "CENTER" },
          transformOrigin: { horizontal: "RIGHT", vertical: "CENTER" },
        });
        return false;
      },
    })
    .then(() => {
      diagnostics.toolCreatedAt = Date.now();
    })
    .catch((error: unknown) => {
      diagnostics.toolCreateError =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[diagnostic-b] Tool creation failed.", error);
    });
});
