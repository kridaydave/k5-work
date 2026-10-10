import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it, type TestContext } from "node:test";
import { resolveAccessProfile } from "@k5-work/shared";
import {
  PostureTooWeakError,
  PostureUnverifiableError,
  resolvePosture,
  verifyPosture,
} from "./posture.js";

// Ground truth for the pinned OpenCode binary, verified in a real project
// directory. This is the check the research insisted on: the merged harness
// configuration is the permission boundary, so a profile promise is only
// meaningful if the resolved posture actually matches it.
const OPENCODE_ARGV = ["opencode", "acp"];
const REAL_CWD = process.env.K5_POSTURE_PROBE_CWD ?? process.cwd();

function requireOpencode(t: TestContext): boolean {
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch (err) {
    t.skip(`opencode not runnable here: ${(err as Error).message}`);
    return false;
  }
}

describe("real opencode posture", () => {
  it("resolves a blanket wildcard allow for the build agent", async (t) => {
    if (!requireOpencode(t)) return;
    const posture = await resolvePosture({
      command: "opencode",
      cwd: REAL_CWD,
      env: process.env,
      agent: "build",
      timeoutMs: 60_000,
    });
    assert.equal(
      posture.wildcardAllow,
      true,
      "if this changes, the read/review refusals below must be revisited",
    );
    assert.ok(posture.ruleCount > 0);
  });

  it("refuses the read and review profiles against the real build agent", async (t) => {
    if (!requireOpencode(t)) return;
    for (const label of ["read", "review"] as const) {
      await assert.rejects(
        verifyPosture({
          command: "opencode",
          cwd: REAL_CWD,
          env: process.env,
          agent: "build",
          timeoutMs: 60_000,
          profile: resolveAccessProfile(label),
        }),
        (err: unknown) =>
          err instanceof PostureTooWeakError && err.offending.includes("*"),
        `the "${label}" profile must be refused, not silently downgraded`,
      );
    }
  });

  it("accepts the full profile against the real build agent", async (t) => {
    if (!requireOpencode(t)) return;
    const posture = await verifyPosture({
      command: "opencode",
      cwd: REAL_CWD,
      env: process.env,
      agent: "build",
      timeoutMs: 60_000,
      profile: resolveAccessProfile("full"),
    });
    assert.equal(posture.wildcardAllow, true);
  });

  it("still denies edits under the plan agent, so plan is not a no-ask profile", async (t) => {
    if (!requireOpencode(t)) return;
    // The plan agent appends `edit: deny` on top of a `*: allow` wildcard, which
    // is why plan is unsafe to treat as a read-only posture: bash and everything
    // else still falls through the wildcard.
    const posture = await resolvePosture({
      command: "opencode",
      cwd: REAL_CWD,
      env: process.env,
      agent: "plan",
      timeoutMs: 60_000,
    });
    assert.equal(posture.wildcardAllow, true);
    // plan's edit grant is scoped to plan files, not global. That is why the
    // wildcard still matters: everything else, shell included, is allowed.
    const editGrant = posture.grants.find((g) => g.permission === "edit");
    assert.ok(editGrant, "plan does allow edit for plan files");
    assert.notEqual(editGrant.pattern, "*", "the edit grant must stay scoped");
    assert.ok(
      !posture.grants.some((g) => g.permission === "shell"),
      "shell is not named, so it falls through the wildcard to allow",
    );
    await assert.rejects(
      verifyPosture({
        command: "opencode",
        cwd: REAL_CWD,
        env: process.env,
        agent: "plan",
        timeoutMs: 60_000,
        profile: resolveAccessProfile("read"),
      }),
      PostureTooWeakError,
    );
  });

  it("reports an unknown agent as unverifiable rather than a pass", async (t) => {
    if (!requireOpencode(t)) return;
    await assert.rejects(
      resolvePosture({
        command: "opencode",
        cwd: REAL_CWD,
        env: process.env,
        agent: "definitely-not-an-agent-xyz",
        timeoutMs: 60_000,
      }),
      PostureUnverifiableError,
    );
  });
});
