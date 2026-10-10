import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type PluginSignal =
  | "opencode-plugins-dir"
  | "opencode-agents-dir"
  | "opencode-json-plugin"
  | "opencode-json-unreadable";

export interface PluginFinding {
  signal: PluginSignal;
  path: string;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Detects project-supplied behaviour that lives outside any k5 profile.
 *
 * A project's own config, agents, and plugins are inside the trust boundary.
 * Measured against OpenCode 2.0.24 in a clean config sandbox: a top-level
 * `permission` block is still dropped rather than merged, and an
 * `agent.<name>.permission` block now merges into the resolved rules. Either
 * way the wildcard `*: allow` stays the first rule, so a project's config can
 * narrow its own seat and can never widen one past what the profile already
 * grants. A plugin is the remaining way to widen behaviour, because it is code
 * inside the harness and no permission vocabulary describes it. Such a project
 * is refused and the offending signal is named. Re-measured evidence and the
 * narrowed-versus-widened reasoning live in docs/posture-and-trust-decisions.md
 * section 5.
 */
export function findPluginSignals(projectRoot: string): PluginFinding[] {
  const found: PluginFinding[] = [];
  const root = path.resolve(projectRoot);

  const pluginsDir = path.join(root, ".opencode", "plugin");
  const pluginsDirPlural = path.join(root, ".opencode", "plugins");
  if (existsSync(pluginsDir) || existsSync(pluginsDirPlural)) {
    found.push({
      signal: "opencode-plugins-dir",
      path: existsSync(pluginsDir) ? pluginsDir : pluginsDirPlural,
    });
  }

  const agentsDir = path.join(root, ".opencode", "agent");
  const agentsDirPlural = path.join(root, ".opencode", "agents");
  if (existsSync(agentsDir) || existsSync(agentsDirPlural)) {
    found.push({
      signal: "opencode-agents-dir",
      path: existsSync(agentsDir) ? agentsDir : agentsDirPlural,
    });
  }

  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    if (!statSync(file).isFile()) continue;
    found.push(...readPluginSignals(file));
  }

  return found;
}

function readPluginSignals(file: string): PluginFinding[] {
  let raw: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return [];
    if (stat.size > MAX_CONFIG_BYTES) {
      // "We could not check it" is not "there is nothing to check". A long MCP
      // inventory is an ordinary reason to be large, so this is a refusal with
      // its own signal rather than a silent pass.
      return [{ signal: "opencode-json-unreadable", path: file }];
    }
    raw = readFileSync(file, "utf8");
  } catch {
    // An unreadable config is not proof of a plugin, but it is proof the project
    // cannot be vetted, so it is refused with a named reason.
    return [{ signal: "opencode-json-unreadable", path: file }];
  }

  // JSONC is not JSON, so a strict parse would miss a commented config that
  // declares a plugin. Falling back to a text probe keeps the refusal honest
  // for both formats.
  let declared = false;
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    declared = declaresPlugin(parsed);
  } catch {
    declared = /"plugin"\s*:/.test(raw);
  }

  return declared ? [{ signal: "opencode-json-plugin", path: file }] : [];
}

function declaresPlugin(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  const plugin = record.plugin;
  if (Array.isArray(plugin)) return plugin.length > 0;
  if (typeof plugin === "string") return plugin.length > 0;
  if (typeof plugin === "object" && plugin !== null) {
    return Object.keys(plugin).length > 0;
  }
  return false;
}

function stripJsonComments(raw: string): string {
  return raw
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) =>
      comment ? "" : match,
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

export function describeFinding(finding: PluginFinding): string {
  switch (finding.signal) {
    case "opencode-plugins-dir":
      return `project ships OpenCode plugins at ${finding.path}`;
    case "opencode-agents-dir":
      return `project defines OpenCode agents at ${finding.path}`;
    case "opencode-json-plugin":
      return `${finding.path} declares a plugin`;
    case "opencode-json-unreadable":
      return `${finding.path} could not be checked for plugins (too large or unreadable)`;
  }
}
