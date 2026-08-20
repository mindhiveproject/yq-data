import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Point at the source rather than dist, so editing the package is
      // reflected in the demo on save without a rebuild or an npm link.
      "yq-data": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  server: {
    // Web Bluetooth, getUserMedia and AudioWorklet all require a secure
    // context; localhost counts as one, so no certificate is needed.
    host: "localhost",
  },
});
