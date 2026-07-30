/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm test` runs `vitest run` (one-shot). Never run vitest in watch mode in
// automated environments.
export default defineConfig({
  plugins: [react()],
  server: {
    // Fixed, non-default port so orchestrator never collides with the other
    // Vite apps on this machine; strictPort fails loudly instead of silently
    // hopping to a neighboring port.
    port: 4400,
    strictPort: true,
    proxy: {
      // Forward API calls to the loopback Express backend during dev so the SPA
      // can use same-origin relative paths (see src/api.ts).
      "/api": {
        target: "http://127.0.0.1:3007",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    // Run test FILES sequentially (no cross-file parallelism). Several page
    // tests drive async data loading (autofill, facet/suggestion fetches) whose
    // waitFor timings race under CPU contention when many files run at once,
    // failing intermittently on a loaded machine. This is the web mirror of the
    // backend's `jest --runInBand`: determinism over raw speed for a gate.
    fileParallelism: false,
  },
});
