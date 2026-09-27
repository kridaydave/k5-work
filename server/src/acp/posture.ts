import { execFile } from "node:child_process";
import type { AccessProfile } from "@k5-work/shared";
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

export interface AllowedGrant {
  permission: string;
  pattern: string;
}

export interface ResolvedPosture {
  /** Named permissions the harness resolves to `allow`. */
  allowedTools: string[];
  /** True when the harness resolves a blanket `*: allow`. */
  wildcardAllow: boolean;
  ruleCount: number;
  /**
   * The allow rules with their patterns, so a refusal can name the scope that
   * caused it. A permission allowed only for `.opencode/plans/*.md` is a very
   * different fact from one allowed everywhere, and the operator needs to see
   * which one was actually resolved.
   */
  grants: AllowedGrant[];
}

export interface ResolvePostureOptions {
  /**
   * Harness binary only, e.g. "opencode". The resolver is a different
   * subcommand from the seat's (`debug agent` vs `acp`), so passing the seat
   * argv would ask `opencode acp debug agent ...`, which the CLI rejects.
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

function runResolver(
  command: string,
  agent: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ ok: false, reason: "no harness command configured" });
      return;
    }
    // `debug agent` already emits JSON; it takes no --json flag and prints
    // help instead, which would otherwise be parsed as a broken posture.
    execFile(
      command,
      ["debug", "agent", agent],
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
export async function resolvePosture(
  options: ResolvePostureOptions,
): Promise<ResolvedPosture> {
  const timeoutMs = options.timeoutMs ?? POSTURE_TIMEOUT_MS;
  const result = await runResolver(
    options.command,
    options.agent,
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

  const rules = (parsed as { permission?: unknown }).permission;
  if (!Array.isArray(rules)) {
    throw new PostureUnverifiableError("resolver output had no permission array");
  }

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
