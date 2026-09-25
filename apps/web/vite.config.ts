import path from "path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { handleProjectApiRequest } from "../../server/src/project-api.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function projectDiscoveryPlugin(): Plugin {
  return {
    name: "k5-project-discovery-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handleProjectApiRequest(
          req as IncomingMessage,
          res as ServerResponse,
          next,
          path.resolve(__dirname, "../.."),
        );
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        handleProjectApiRequest(
          req as IncomingMessage,
          res as ServerResponse,
          next,
          path.resolve(__dirname, "../.."),
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), projectDiscoveryPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
