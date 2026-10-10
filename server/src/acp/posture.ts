import { execFile } from "node:child_process";
import type { AccessProfile, ResolvedPostureReport } from "@k5-work/shared";
import { isPostureAcceptable } from "@k5-work/shared";

export class PostureUnverifiableError extends Error {
  constructor(reason: string) {
    super(`permission posture could not be verified: ${reason}`);
    this.name = "PostureUnverifiableError";
  }
}

export class PostureTooWeakError extends Error {
  constructor(
    readonly offending: string[],
    readonly profile: AccessProfile,
    readonly scopes: string[] = [],
  ) {
    super(
      `resolved harness posture allows ${JSON.stringify(offending)}, ` +
        `which the "${profile.label}" profile does not permit` +
        (scopes.length > 0 ? `; matched scopes: ${scopes.join(", ")}` : ""),
    );
    this.name = "PostureTooWeakError";
  }
}

/**
 * The resolver's own result, derived from the wire schema rather than restated
 * beside it.
 *
 * Two independent declarations of the same record would drift the first time a
 * field was added on one side, and the drift would be silent: the wire is
 * validated by Zod, so a stale copy would fail at the boundary and the report
 * the operator sees would just stop arriving. Deriving makes that impossible.
 * The wire adds `verified`, which is not the resolver's business to decide.
 */
export type ResolvedPosture = Omit<ResolvedPostureReport, "verified">;

export type AllowedGrant = ResolvedPosture["grants"][number];

/**
 * The reportable form of a resolved posture.
 *
 * `ruleCount === 0` is the honest discriminator between "resolved" and
 * "assumed": `resolvePosture` refuses a rule list with no readable allow grant,
 * so every posture it returns counted at least one rule, and the only zero-count
 * posture in existence is the one `verifyPosture` substitutes for `full` when the
 * resolver could not be read at all. Its `wildcardAllow: true` is a promise to
 * paper over the gap, and a viewer must not be shown it as an observed grant.
 */
export function reportPosture(posture: ResolvedPosture): ResolvedPostureReport {
  return { ...posture, verified: posture.ruleCount > 0 };
}

export interface ResolvePostureOptions {
  /**
   * Harness binary only, e.g. "opencode". The resolver is a different
   * subcommand from the seat's (`debug agents` vs `acp`), so passing the seat
   * argv would ask `opencode acp debug agents ...`, which the CLI rejects.
   */
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Agent whose merged configuration governs the seat. */
  agent: string;
  timeoutMs?: number;
}

const POSTURE_TIMEOUT_MS = 20_000;

type RunResult = { ok: true; stdout: string } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runResolver(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ ok: false, reason: "no harness command configured" });
      return;
    }
    // `debug agents` already emits JSON; it takes no --json flag and prints
    // help instead, which would otherwise be parsed as a broken posture. It
    // lists every agent, so the one being verified is selected from the output
    // rather than named on the command line.
    execFile(
      command,
      ["debug", "agents"],
      { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout });
          return;
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        resolve({
          ok: false,
          reason: err.killed
            ? `resolver timed out after ${timeoutMs}ms`
            : `resolver failed: ${err.message}${stderr.trim() ? ` (${stderr.trim()})` : ""}`,
        });
      },
    );
  });
}

/**
 * Runs the harness's own resolver in the seat's real environment. Anything
 * project-supplied (opencode.json, .opencode/agents, plugins) is part of the
 * command, which is the point: the merged result is what actually applies, so
 * an injected profile cannot be assumed to defeat an override.
 */
/**
 * Reads the agents array, spending one retry on the harness's cold start.
 *
 * The harness answers the first `debug agents` in a project directory it has
 * not initialised with an empty array, and the full list on the very next
 * call; measured as call 1 returning 0 agents and call 2 returning 9 in every
 * fresh directory tried, so the retry is call-based rather than timed. An
 * empty list is not a posture, so the second call is spent before the posture
 * is declared unreadable. Returns null when both answers were empty.
 */
async function readAgents(
  options: ResolvePostureOptions,
  timeoutMs: number,
): Promise<unknown[] | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runResolver(
      options.command,
      options.cwd,
      options.env,
      timeoutMs,
    );
    if (!result.ok) throw new PostureUnverifiableError(result.reason);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new PostureUnverifiableError("resolver output was not JSON");
    }

    if (!Array.isArray(parsed)) {
      throw new PostureUnverifiableError(
        "resolver output was not the agents array the harness advertises",
      );
    }
    if (parsed.length > 0) return parsed;
  }
  return null;
}

export async function resolvePosture(
  options: ResolvePostureOptions,
): Promise<ResolvedPosture> {
  const timeoutMs = options.timeoutMs ?? POSTURE_TIMEOUT_MS;
  const agents = await readAgents(options, timeoutMs);
  if (agents === null) {
    throw new PostureUnverifiableError("resolver reported no agents to read");
  }

  const agent = agents.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry["id"] === options.agent,
  );
  if (agent === undefined) {
    // Named, not assumed: an agent that has since been renamed or removed must
    // not silently fall through to a different agent's posture.
    throw new PostureUnverifiableError(
      `resolver listed no agent named "${options.agent}"`,
    );
  }

  const rawRules = agent["permissions"];
  if (!Array.isArray(rawRules)) {
    throw new PostureUnverifiableError("resolver output had no permissions array");
  }

  // The harness names the permission in `action`, its pattern in `resource`,
  // and the verdict in `effect`. Normalised here so the classification below
  // reads one shape and the harness's wire vocabulary stops at this function.
  const rules = rawRules.map((rule) => {
    const r = isRecord(rule) ? rule : {};
    return {
      permission: typeof r["action"] === "string" ? r["action"] : "",
      pattern: typeof r["resource"] === "string" ? r["resource"] : "*",
      action: typeof r["effect"] === "string" ? r["effect"].toLowerCase() : "",
    };
  });

  const allowedTools: string[] = [];
  const grants: AllowedGrant[] = [];
  let wildcardAllow = false;
  let unrecognisedActions = 0;

  for (const rule of rules) {
    const r = rule as { permission?: unknown; action?: unknown; pattern?: unknown };
    // Compared case-insensitively: a differently-cased action must not be
    // silently dropped, because dropping an `allow` widens the posture.
    const action = typeof r.action === "string" ? r.action.toLowerCase() : "";
    if (action !== "allow") {
      if (action !== "deny" && action !== "ask") unrecognisedActions += 1;
      continue;
    }
    const permission = typeof r.permission === "string" ? r.permission : "";
    const pattern = typeof r.pattern === "string" ? r.pattern : "*";
    if (permission === "" || permission === "*") {
      if (pattern === "*") {
        wildcardAllow = true;
      } else {
        // A blanket permission scoped to a subtree is still an allow-everything
        // grant over that subtree. Recording it as a grant keeps it visible to
        // the profile check instead of erasing it from the record.
        grants.push({ permission: "*", pattern });
      }
      continue;
    }
    allowedTools.push(permission);
    grants.push({ permission, pattern });
  }

  // An empty allow list is not a narrow posture, it is an unreadable one:
  // `isPostureAcceptable` treats "no grants" as trivially compliant.
  if (rules.length === 0 || (allowedTools.length === 0 && !wildcardAllow && grants.length === 0)) {
    throw new PostureUnverifiableError(
      `resolver reported ${String(rules.length)} rules but no readable allow grants`,
    );
  }
  if (unrecognisedActions > 0) {
    throw new PostureUnverifiableError(
      `${String(unrecognisedActions)} permission rule(s) used an unrecognised action`,
    );
  }

  return { allowedTools, wildcardAllow, ruleCount: rules.length, grants };
}

export interface VerifyPostureOptions extends ResolvePostureOptions {
  profile: AccessProfile;
}

/**
 * Fails closed. An unreadable posture is not a trustworthy one, and a posture
 * wider than the profile is refused rather than quietly downgraded, because a
 * refusal is visible and a silent over-grant is not.
 *
 * `full` is the one profile that tolerates an unverifiable posture: it promises
 * nothing narrower than the harness default, so there is no gap to paper over.
 */
export async function verifyPosture(
  options: VerifyPostureOptions,
): Promise<ResolvedPosture> {
  let posture: ResolvedPosture;
  try {
    posture = await resolvePosture(options);
  } catch (err) {
    if (options.profile.label === "full") {
      return { allowedTools: [], wildcardAllow: true, ruleCount: 0, grants: [] };
    }
    throw err;
  }

  // A scoped `*: allow` is treated as a wildcard for the comparison: a grant
  // over a subtree is still an over-broad allow for a read posture.
  const scopedWildcard = posture.grants.some((g) => g.permission === "*");
  const tools =
    posture.wildcardAllow || scopedWildcard
      ? ["*", ...posture.allowedTools]
      : posture.allowedTools;
  const verdict = isPostureAcceptable(tools, options.profile);
  if (!verdict.ok) {
    // Naming the offending pattern is what lets an operator judge the refusal
    // instead of having to re-run the resolver by hand.
    const scopes = posture.grants
      .filter((g) => verdict.offending.includes(g.permission))
      .map((g) => `${g.permission} (${g.pattern})`);
    throw new PostureTooWeakError(verdict.offending, options.profile, scopes);
  }
  return posture;
}
