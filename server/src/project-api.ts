import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { ProjectOpenRequestSchema } from "@k5-work/shared";
import { isSafeNameSegment } from "./store/safe-name.js";
import { discoverLocalProjects, getProjectInfo } from "./projects.js";

function contentDisposition(name: string): string {
  const fallback =
    name
      .replace(/[^\x20-\x7e]+/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 200) || "attachment";
  const extended = encodeURIComponent(name).replace(/'/g, "%27");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

export const MAX_PROJECT_BODY_BYTES = 64 * 1024;

type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "invalid" | "too_large" | "timeout" };

export const PROJECT_BODY_TIMEOUT_MS = 10_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function hasJsonContentType(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function contentLengthExceedsLimit(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return false;
  const length = Number(value);
  return Number.isFinite(length) && length > MAX_PROJECT_BODY_BYTES;
}

export function readJsonBody(
  stream: Readable,
  maxBytes = MAX_PROJECT_BODY_BYTES,
  timeoutMs = PROJECT_BODY_TIMEOUT_MS,
): Promise<JsonBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (timer !== undefined) clearTimeout(timer);
    };
    const finish = (result: JsonBodyResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > maxBytes) {
        chunks.length = 0;
        finish({ ok: false, reason: "too_large" });
        stream.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (size > maxBytes) {
        finish({ ok: false, reason: "too_large" });
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
        finish({ ok: true, value: JSON.parse(text) as unknown });
      } catch {
        finish({ ok: false, reason: "invalid" });
      }
    };
    const onError = (): void => {
      finish({ ok: false, reason: "invalid" });
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
      stream.resume();
    }, timeoutMs);
  });
}

function projectPath(value: unknown): string | null {
  const parsed = ProjectOpenRequestSchema.safeParse(value);
  return parsed.success ? parsed.data.path : null;
}

function isProjectApiPath(pathname: string): boolean {
  return (
    pathname === "/api/projects" ||
    pathname.startsWith("/api/projects/") ||
    pathname.startsWith("/api/project/") ||
    pathname.startsWith("/api/files/") ||
    pathname.startsWith("/api/project-files/")
  );
}

function decodeFileSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("/") || decoded.includes("\\\\")) return null;
  return isSafeNameSegment(decoded) ? decoded : null;
}

function projectFileRoute(pathname: string): string | null {
  const prefixes = ["/api/projects/", "/api/project/", "/api/files/", "/api/project-files/"];
  for (const prefix of prefixes) {
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    if (rest === "") continue;
    const parts = rest.split("/").filter((segment) => segment.length > 0);
    let raw: string | undefined;
    if (parts.length === 1) {
      raw = parts[0];
    } else if (parts.length === 2 && (parts[0] === "file" || parts[0] === "files")) {
      raw = parts[1];
    }
    if (raw === undefined) return null;
    return decodeFileSegment(raw);
  }
  return null;
}

function serveProjectFile(
  req: IncomingMessage,
  res: ServerResponse,
  filename: string,
  workspaceRoot: string,
): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, filename);
  if (target !== path.join(root, filename)) {
    sendJson(res, 400, { error: "Invalid filename" });
    return;
  }
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(target);
  } catch {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  const relative = path.relative(realRoot, realTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(realTarget);
  } catch {
    sendJson(res, 500, { error: "Could not read file" });
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(bytes.byteLength));
  res.setHeader("Content-Disposition", contentDisposition(filename));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(bytes);
}

export function handleProjectApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  workspaceRoot: string,
): void {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? "/", "http://k5-work.invalid").pathname;
  } catch {
    sendJson(res, 400, { error: "Invalid request URL" });
    return;
  }
  if (!isProjectApiPath(pathname)) {
    next();
    return;
  }

  if (pathname === "/api/projects/open") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (!hasJsonContentType(req.headers["content-type"])) {
      sendJson(res, 415, { error: "Content-Type must be application/json" });
      return;
    }
    if (contentLengthExceedsLimit(req.headers["content-length"])) {
      req.resume();
      sendJson(res, 413, { error: "Request body is too large" });
      return;
    }
    void readJsonBody(req).then((body) => {
      if (body.ok === false) {
        const status = body.reason === "too_large" ? 413 : body.reason === "timeout" ? 408 : 400;
        if (body.reason === "timeout") res.setHeader("Connection", "close");
        sendJson(res, status, {
          error:
            body.reason === "too_large"
              ? "Request body is too large"
              : body.reason === "timeout"
                ? "Request body timed out"
                : "Invalid JSON",
        });
        return;
      }
      const targetPath = projectPath(body.value);
      if (targetPath === null) {
        sendJson(res, 400, { error: "Missing or invalid path" });
        return;
      }
      const info = getProjectInfo(targetPath);
      if (info === null) {
        sendJson(res, 404, { error: "Folder not found or is not a directory" });
        return;
      }
      sendJson(res, 200, info);
    });
    return;
  }

  if (pathname === "/api/projects" || pathname === "/api/projects/") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      sendJson(res, 200, discoverLocalProjects(undefined, workspaceRoot));
    } catch (cause) {
      sendJson(res, 500, { error: cause instanceof Error ? cause.message : String(cause) });
    }
    return;
  }

  const requestedFile = projectFileRoute(pathname);
  if (requestedFile !== null) {
    serveProjectFile(req, res, requestedFile, workspaceRoot);
    return;
  }

  sendJson(res, 404, { error: "Project API route not found" });
}
