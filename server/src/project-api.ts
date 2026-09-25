import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { ProjectOpenRequestSchema } from "@k5-work/shared";
import { discoverLocalProjects, getProjectInfo } from "./projects.js";

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
  return pathname === "/api/projects" || pathname.startsWith("/api/projects/");
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

  sendJson(res, 404, { error: "Project API route not found" });
}
