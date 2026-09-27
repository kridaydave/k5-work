import path from "node:path";
import { isIP } from "node:net";

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

export interface ServerConfig {
  port: number;
  host: string;
  allowRemote: boolean;
  workspaceRoot: string;
  // Single source of truth for the seat command. Undefined means "not
  // configured", which is a typed error at seat creation, never a boot crash.
  acpCommand: string | undefined;
  allowedOrigins: readonly string[] | null;
  allowedHosts: readonly string[];
  disableLiveSeats: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") return true;
  const family = isIP(normalized);
  if (family === 4) return normalized === "127.0.0.1" || normalized.startsWith("127.");
  if (family === 6) {
    return normalized === "::1" || normalized.startsWith("::ffff:127.");
  }
  return false;
}

function parsePort(raw: string | undefined): number {
  const value = Number(raw ?? "8787");
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ServerConfigError(
      `PORT must be an integer from 1 to 65535, got ${raw}`,
    );
  }
  return value;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Origins are compared as exact strings, so a near-miss entry would 403 every
 * real browser while looking configured. A malformed entry is rejected at boot
 * with the offending value named.
 */
export function validateOrigins(origins: readonly string[]): string[] {
  const bad: string[] = [];
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      bad.push(origin);
      continue;
    }
    // The Origin header is scheme://host[:port] with no path, query, or
    // credentials, and never a bare host.
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== origin ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      origin === "*"
    ) {
      bad.push(origin);
    }
  }
  if (bad.length > 0) {
    throw new ServerConfigError(
      `K5_ALLOWED_ORIGINS contains entries that are not exact origins: ${JSON.stringify(bad)}`,
    );
  }
  return [...origins];
}

// Loopback names the listener answers for on any port. A DNS-rebinding browser
// sends the rebound name as Host, never a loopback one, so requiring a loopback
// hostname is what defeats it; pinning the port would add nothing and would
// break any client that reached us on a different port.
function deriveLoopbackHosts(): string[] {
  return ["127.0.0.1", "localhost", "::1"];
}

export interface LoadServerConfigOptions {
  env?: NodeJS.ProcessEnv;
  workspaceRoot: string;
}

export function loadServerConfig(options: LoadServerConfigOptions): ServerConfig {
  const env = options.env ?? process.env;

  const port = parsePort(env.PORT);
  const host = env.HOST?.trim() || "127.0.0.1";
  const allowRemote = env.ALLOW_REMOTE === "true";

  // Bind safety is checked before anything optional so the operator always sees
  // the remote-bind refusal first, never an allowlist complaint behind it.
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new ServerConfigError("remote HOST requires ALLOW_REMOTE=true");
  }

  const extraHosts = parseList(env.K5_ALLOWED_HOSTS);
  const allowedHosts = isLoopbackHost(host)
    ? [...new Set([...deriveLoopbackHosts(), ...extraHosts])]
    : extraHosts;

  // A remote bind with no Host allowlist would answer for whatever name resolves
  // to it, so refuse at boot rather than serving a mysteriously dead listener.
  if (allowedHosts.length === 0) {
    throw new ServerConfigError(
      "non-loopback HOST requires K5_ALLOWED_HOSTS with the names this server answers for",
    );
  }

  return {
    port,
    host,
    allowRemote,
    // Injected, never derived from import.meta.url: moving this file must not
    // silently change which directory is treated as the workspace.
    workspaceRoot: path.resolve(options.workspaceRoot),
    acpCommand: env.ACP_COMMAND?.trim() || undefined,
    allowedOrigins: (() => {
      const origins = parseList(env.K5_ALLOWED_ORIGINS);
      return origins.length > 0 ? validateOrigins(origins) : null;
    })(),
    allowedHosts,
    disableLiveSeats: env.K5_DISABLE_LIVE_SEATS === "true",
  };
}

/** Strips an optional port and normalizes IPv6 brackets away. */
function hostNameOnly(header: string): string {
  const lower = header.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? lower : lower.slice(1, end);
  }
  const colon = lower.indexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
}

/**
 * Guards the HTTP surface against DNS rebinding. `Host` is attacker-controlled
 * in a rebinding attack, so this is checked before any request is routed.
 */
export function isAllowedHostHeader(
  header: string | undefined,
  config: ServerConfig,
): boolean {
  if (!header) return false;
  const normalized = header.trim().toLowerCase();
  if (normalized.length === 0) return false;

  // An explicit entry may pin host:port, so it is compared whole first.
  if (config.allowedHosts.some((a) => a.toLowerCase() === normalized)) return true;

  // Then a bare hostname entry accepts any port, which is what a loopback
  // client on an ephemeral port needs.
  const name = hostNameOnly(normalized);
  return config.allowedHosts.some((a) => a.toLowerCase() === name);
}
