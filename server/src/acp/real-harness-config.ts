import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The model the real-harness tests pin, and the project config that pins it.
 *
 * Why this exists: these tests used to run whatever model the machine's
 * OpenCode defaulted to. That default was `exo-free` until the provider
 * deprecated it, and every real turn then failed with "Model exo-free has been
 * deprecated" — a red suite that says nothing about k5. The catalog is not a
 * liveness check either: `opencode models` still listed the dead model. Only a
 * real turn proves a model is alive, and a pinned project config is what makes
 * these tests independent of machine state.
 *
 * When this pin goes stale the failure is loud and names the model, and the
 * fix is one line here rather than a hunt through machine config.
 */
export const PINNED_MODEL = "opencode/step-5-preview-free";

/** Writes the minimal project config that pins PINNED_MODEL into `cwd`. */
export function pinModelIn(cwd: string): void {
  writeFileSync(
    path.join(cwd, "opencode.json"),
    `${JSON.stringify({ model: PINNED_MODEL }, null, 2)}\n`,
    "utf8",
  );
}
