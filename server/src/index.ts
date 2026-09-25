import { createServer } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleProjectApiRequest } from "./project-api.js";

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  const family = isIP(normalized);
  if (family === 4) return normalized === "127.0.0.1" || normalized.startsWith("127.");
  if (family === 6) {
    return normalized === "::1" || normalized.startsWith("::ffff:127.");
  }
  return false;
}

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const portValue = Number(process.env.PORT ?? "8787");
if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
  throw new Error(`PORT must be an integer from 1 to 65535, got ${process.env.PORT}`);
}
const host = process.env.HOST?.trim() || "127.0.0.1";
if (!isLoopbackHost(host) && process.env.ALLOW_REMOTE !== "true") {
  throw new Error("remote HOST requires ALLOW_REMOTE=true");
}

const server = createServer((req, res) => {
  if (req.url?.split("?", 1)[0] === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  handleProjectApiRequest(req, res, () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Not found" }));
  }, workspaceRoot);
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.listen(portValue, host, () => {
  process.stdout.write(`k5-work server listening on ${host}:${portValue}\n`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
