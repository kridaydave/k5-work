import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "../..");

// Deliberately no `watch` and no `globals`: CI and a maintainer laptop both run
// this once. The browser layer is a small, focused suite, not a watch session.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(webRoot, "src"),
      // Resolved to SOURCE, not shared/dist. Against a stale dist the suite
      // would silently test the wrong contract: a neutered reducer case in dist
      // still passes every test. Against src there is no build-order coupling.
      "@k5-work/shared": path.resolve(repoRoot, "shared/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: [path.resolve(webRoot, "src/test/setup.ts")],
    globals: false,
    restoreMocks: true,
  },
});
