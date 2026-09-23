import path from "path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { discoverLocalProjects, getProjectInfo } from "../../server/src/projects.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function handleProjectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (!req.url?.startsWith("/api/projects")) {
    next();
    return;
  }

  if (req.url === "/api/projects/open" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const body: unknown = JSON.parse(raw);
        if (
          typeof body !== "object" ||
          body === null ||
          !("path" in body) ||
          typeof body.path !== "string" ||
          !body.path.trim()
        ) {
          sendJson(res, 400, { error: "Missing or invalid path" });
          return;
        }
        const info = getProjectInfo(body.path);
        if (!info) {
          sendJson(res, 404, { error: "Folder not found or is not a directory" });
          return;
        }
        sendJson(res, 200, info);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON" });
      }
    });
    return;
  }

  if ((req.url === "/api/projects" || req.url === "/api/projects/") && req.method === "GET") {
    try {
      const workspaceRoot = path.resolve(__dirname, "../..");
      const discovery = discoverLocalProjects(undefined, workspaceRoot);
      sendJson(res, 200, discovery);
    } catch (cause) {
      sendJson(res, 500, { error: String(cause) });
    }
    return;
  }

  next();
}

function projectDiscoveryPlugin(): Plugin {
  return {
    name: "k5-project-discovery-api",
    configureServer(server) {
      server.middlewares.use(handleProjectRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleProjectRequest);
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
