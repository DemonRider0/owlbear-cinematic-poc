import { resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",

  server: {
    cors: {
      origin: "https://www.owlbear.rodeo",
    },
  },

  build: {
    rollupOptions: {
      input: {
        background: resolve(projectRoot, "background.html"),
        cinematic: resolve(projectRoot, "cinematic.html"),
        controls: resolve(projectRoot, "controls.html"),
      },
    },
  },
});