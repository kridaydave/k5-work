import { z } from "zod";

// --- access profile ---
// The browser sends a raw composer label; the server derives the profile and
// the seat key. A browser must never be able to pick its own permission
// posture, so these are server-owned and the composer only picks a label.

export const ComposerAccessLabelSchema = z.enum(["read", "review", "full"]);
export type ComposerAccessLabel = z.infer<typeof ComposerAccessLabelSchema>;

/**
 * Permissions that grant real capability: reading, changing, or executing.
 * Verified against `opencode debug agents`, whose rules name the permission in
 * `action`, its pattern in `resource`, and the verdict in `effect`. The resolved
 * set also contains control-flow gates (see below) that gate the agent's own
 * reasoning rather than its reach, and treating those as capabilities would
 * refuse every seat for no security benefit.
 *
 * The v2 harness renamed two of these and reports the new names: `bash` is
 * reported as `shell` and `task` as `subagent`. Both old names stay listed,
 * because the config key is still accepted and an older harness build still
 * reports them. `lsp` and `browser` are new in v2 and are classified as
 * capabilities, but deliberately absent from every profile's allow list below:
 * k5 does not promise an LSP or a browser, so a posture that allows one is
 * refused visibly instead of being granted silently.
 */
export const CAPABILITY_PERMISSIONS = [
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "write",
  "patch",
  "bash",
  "shell",
  "task",
  "subagent",
  "todowrite",
  "skill",
  "webfetch",
  "websearch",
  "lsp",
  "browser",
  "invalid",
] as const;

/**
 * Gates on the agent's control flow, not on its reach. `question` and
 * `plan_enter`/`plan_exit` decide how the agent proceeds; `doom_loop` and
 * `external_directory` are loop and sandbox guards. None of them let it touch
 * a file or run a command that the capability set does not already allow.
 */
export const CONTROL_FLOW_PERMISSIONS = [
  "question",
  "plan_enter",
  "plan_exit",
  "doom_loop",
  "external_directory",
] as const;

export type CapabilityPermission = (typeof CAPABILITY_PERMISSIONS)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITY_PERMISSIONS);
const CONTROL_FLOW_SET: ReadonlySet<string> = new Set(CONTROL_FLOW_PERMISSIONS);

export function isCapabilityPermission(name: string): boolean {
  return CAPABILITY_SET.has(name);
}

export function isControlFlowPermission(name: string): boolean {
  return CONTROL_FLOW_SET.has(name);
}

export interface AccessProfile {
  label: ComposerAccessLabel;
  /** Human-readable; becomes the model/access pill copy. */
  description: string;
  /** Capabilities k5 lets through without asking. */
  allow: readonly string[];
  /** Capabilities that must be refused outright for this profile. */
  deny: readonly string[];
  /** Actions the harness must ask about; k5's gate decides them. */
  ask: readonly string[];
  /**
   * True when the profile delegates the whole capability set to the harness
   * rather than naming a narrower one. Only `full` may set this, because a
   * blanket allow is exactly the over-grant the other profiles exist to stop.
   */
  allowWildcard: boolean;
}

const READ_TOOLS = ["read", "grep", "glob", "list"] as const;
const REVIEW_TOOLS = [...READ_TOOLS, "todowrite"] as const;

export const ACCESS_PROFILES: Record<ComposerAccessLabel, AccessProfile> = {
  read: {
    label: "read",
    description: "Read files only. No edits, no shell.",
    allow: READ_TOOLS,
    // `shell` is the v2 name of `bash` and `subagent` the v2 name of `task`;
    // both are denied because both are the same reach either way.
    deny: ["edit", "write", "patch", "bash", "shell", "task", "subagent", "invalid"],
    ask: ["external_directory", "doom_loop"],
    allowWildcard: false,
  },
  review: {
    label: "review",
    description: "Read files and plan. Edits are proposed, never applied.",
    allow: REVIEW_TOOLS,
    deny: ["bash", "shell", "task", "subagent", "invalid"],
    ask: ["edit", "write", "patch", "external_directory", "doom_loop"],
    allowWildcard: false,
  },
  full: {
    label: "full",
    description: "Read, edit, and run shell commands.",
    allow: [
      "read",
      "grep",
      "glob",
      "list",
      "edit",
      "write",
      "patch",
      "bash",
      "shell",
      "todowrite",
      "task",
      "subagent",
      "skill",
      "webfetch",
      "websearch",
    ],
    deny: [],
    ask: ["external_directory", "doom_loop"],
    // `full` promises nothing narrower than the harness default, so a blanket
    // allow is the posture it is asking for rather than a violation of it.
    allowWildcard: true,
  },
};

export function resolveAccessProfile(
  label: ComposerAccessLabel,
): AccessProfile {
  return ACCESS_PROFILES[label];
}

/**
 * The only profiles a seat may be opened with.
 *
 * OpenCode's `build` agent resolves `*: allow` by default, verified against
 * 2.0.24 with no project config, and v2 merges project and agent permission
 * config on top of that default rather than dropping it. A narrower profile is
 * a promise the harness's own default contradicts: `isPostureAcceptable`
 * refuses a wildcard for `read` and `review`, so both would fail every seat
 * open on the default posture. A project can narrow the resolved posture, at
 * which point the narrower profiles could be servable; that is a product
 * decision to take deliberately, not a side effect of a harness upgrade.
 * See docs/posture-and-trust-decisions.md.
 */
export const SERVABLE_PROFILES = ["full"] as const satisfies readonly ComposerAccessLabel[];

export type ServableProfile = (typeof SERVABLE_PROFILES)[number];

export function isServableProfile(
  label: ComposerAccessLabel,
): label is ServableProfile {
  return (SERVABLE_PROFILES as readonly string[]).includes(label);
}

export interface PostureVerdict {
  ok: boolean;
  /** Capabilities the harness would grant that the profile does not permit. */
  offending: string[];
  /** Control-flow gates seen but excluded from the capability comparison. */
  controlFlow: string[];
}

/**
 * Decides whether a resolved harness posture is no broader than the profile.
 *
 * Fails toward refusal on purpose. A posture that is broader than promised is
 * refused rather than downgraded, because a refusal is visible to the operator
 * and a silent over-grant is not.
 */
export function isPostureAcceptable(
  allowedTools: readonly string[],
  profile: AccessProfile,
): PostureVerdict {
  const controlFlow = allowedTools.filter(isControlFlowPermission);
  const capabilities = allowedTools.filter(isCapabilityPermission);
  const unknown = allowedTools.filter(
    (name) => !isCapabilityPermission(name) && !isControlFlowPermission(name),
  );

  // An unrecognised name is treated as a capability, so a harness that invents
  // a new permission cannot slip past by being unlisted.
  const considered = [...capabilities, ...unknown];

  if (allowedTools.includes("*")) {
    return profile.allowWildcard
      ? { ok: true, offending: [], controlFlow }
      : { ok: false, offending: ["*"], controlFlow };
  }

  const permitted = new Set<string>([...profile.allow, ...profile.ask]);
  const offending = considered.filter((tool) => !permitted.has(tool));
  return { ok: offending.length === 0, offending, controlFlow };
}
