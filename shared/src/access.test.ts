import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCESS_PROFILES,
  CAPABILITY_PERMISSIONS,
  SERVABLE_PROFILES,
  CONTROL_FLOW_PERMISSIONS,
  ComposerAccessLabelSchema,
  isCapabilityPermission,
  isControlFlowPermission,
  isPostureAcceptable,
  isServableProfile,
  resolveAccessProfile,
} from "./access.js";

describe("access profiles", () => {
  it("exposes exactly the three composer labels", () => {
    assert.deepEqual(Object.keys(ACCESS_PROFILES).sort(), ["full", "read", "review"]);
    for (const label of ["read", "review", "full"] as const) {
      assert.equal(ComposerAccessLabelSchema.safeParse(label).success, true);
    }
    assert.equal(ComposerAccessLabelSchema.safeParse("yolo").success, false);
  });

  it("never lets a profile both allow and deny the same tool", () => {
    for (const profile of Object.values(ACCESS_PROFILES)) {
      const overlap = profile.allow.filter((t) => profile.deny.includes(t));
      assert.deepEqual(overlap, [], `${profile.label} allows and denies ${overlap}`);
      const askOverlap = profile.allow.filter((t) => profile.ask.includes(t));
      assert.deepEqual(askOverlap, [], `${profile.label} allows and asks ${askOverlap}`);
    }
  });

  it("agrees with SERVABLE_PROFILES on which profiles may claim a wildcard", () => {
    // SERVABLE_PROFILES is the locked decision; allowWildcard is the property it
    // depends on. Deriving one from the other here is a real cross-check, not a
    // second copy of the same rule.
    for (const profile of Object.values(ACCESS_PROFILES)) {
      assert.equal(
        profile.allowWildcard,
        isServableProfile(profile.label),
        `${profile.label}: allowWildcard must match servability`,
      );
    }
  });

  it("keeps capability and control-flow vocabularies disjoint", () => {
    for (const name of CAPABILITY_PERMISSIONS) {
      assert.equal(isControlFlowPermission(name), false, `${name} is a capability`);
      assert.equal(isCapabilityPermission(name), true);
    }
    for (const name of CONTROL_FLOW_PERMISSIONS) {
      assert.equal(isCapabilityPermission(name), false, `${name} is control flow`);
      assert.equal(isControlFlowPermission(name), true);
    }
  });

  it("classifies every name a real harness resolves", () => {
    // These are the named permissions `opencode debug agents` resolves in
    // 2.0.24, probed by setting every candidate key in a project config and
    // reading the resolved rules back. `shell` is the v2 name of `bash` and
    // `subagent` the v2 name of `task`; `lsp` and `browser` are new. If the
    // harness adds one, the posture check must still treat it as a capability
    // rather than ignoring it.
    for (const name of [
      "external_directory",
      "plan_enter",
      "plan_exit",
      "question",
      "doom_loop",
      "read",
      "edit",
      "glob",
      "grep",
      "list",
      "shell",
      "bash",
      "subagent",
      "task",
      "todowrite",
      "skill",
      "webfetch",
      "websearch",
      "lsp",
      "browser",
      "invalid",
    ]) {
      assert.ok(
        isCapabilityPermission(name) || isControlFlowPermission(name),
        `${name} must be classified`,
      );
    }
  });

  it("denies shell in every profile except full", () => {
    for (const label of ["read", "review"] as const) {
      // Both names, because v2 reports `shell` while the config key and older
      // builds still say `bash`. The list is not what stops either of them:
      // `isPostureAcceptable` only passes a capability named in `allow` or
      // `ask`, so `shell` is refused under read because it is in neither.
      for (const name of ["bash", "shell"]) {
        assert.ok(
          resolveAccessProfile(label).deny.includes(name),
          `${label} must deny ${name}`,
        );
      }
    }
    for (const name of ["bash", "shell"]) {
      assert.ok(!resolveAccessProfile("full").deny.includes(name));
      assert.ok(resolveAccessProfile("full").allow.includes(name));
    }
  });

  it("denies edits in the read profile", () => {
    assert.ok(resolveAccessProfile("read").deny.includes("edit"));
  });
});

// The harness config is the real boundary, so a profile is only honored when
// the resolved posture is no broader than the profile promises.
describe("posture acceptability", () => {
  it("accepts a posture that stays inside the read profile", () => {
    const result = isPostureAcceptable(["read", "grep"], resolveAccessProfile("read"));
    assert.equal(result.ok, true);
    assert.deepEqual(result.offending, []);
  });

  it("refuses a wildcard posture for the read profile", () => {
    // This is what `opencode debug agents` actually resolves to for `build`.
    const result = isPostureAcceptable(
      ["*", "shell", "edit"],
      resolveAccessProfile("read"),
    );
    assert.equal(result.ok, false);
    assert.ok(result.offending.includes("*"));
  });

  it("refuses a posture that allows an edit under the read profile", () => {
    const result = isPostureAcceptable(["read", "edit"], resolveAccessProfile("read"));
    assert.equal(result.ok, false);
    assert.deepEqual(result.offending, ["edit"]);
  });

  it("excludes control-flow gates from the capability comparison", () => {
    // `plan_enter` and `question` are how the agent reasons, not what it can
    // reach. Refusing a seat over them would be noise, not safety.
    const result = isPostureAcceptable(
      ["read", "question", "plan_enter"],
      resolveAccessProfile("read"),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.offending, []);
    assert.deepEqual(result.controlFlow.sort(), ["plan_enter", "question"]);
  });

  it("treats an unrecognised permission as a capability, not as harmless", () => {
    const result = isPostureAcceptable(
      ["read", "some_future_exec"],
      resolveAccessProfile("read"),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.offending, ["some_future_exec"]);
  });

  it("accepts a wildcard only for the full profile", () => {
    assert.equal(isPostureAcceptable(["*"], resolveAccessProfile("full")).ok, true);
    assert.equal(isPostureAcceptable(["*"], resolveAccessProfile("review")).ok, false);
    assert.equal(isPostureAcceptable(["*"], resolveAccessProfile("read")).ok, false);
  });

  it("ships exactly one servable profile", () => {
    assert.deepEqual([...SERVABLE_PROFILES], ["full"]);
    assert.equal(isServableProfile("full"), true);
    assert.equal(isServableProfile("read"), false);
    assert.equal(isServableProfile("review"), false);
  });

  it("accepts a full posture for the full profile", () => {
    const result = isPostureAcceptable(
      ["read", "edit", "write", "patch", "bash"],
      resolveAccessProfile("full"),
    );
    assert.equal(result.ok, true);
  });

  it("still refuses a write under the review profile, which only asks", () => {
    // review *asks* for edit, so an outright allow of an unlisted capability is
    // still a violation.
    const result = isPostureAcceptable(
      ["read", "bash"],
      resolveAccessProfile("review"),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.offending, ["bash"]);
  });
});
