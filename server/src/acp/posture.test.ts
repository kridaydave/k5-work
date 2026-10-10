import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { resolveAccessProfile } from "@k5-work/shared";
import {
  PostureTooWeakError,
  PostureUnverifiableError,
  resolvePosture,
  verifyPosture,
} from "./posture.js";

// A stand-in for `opencode debug agents`, so the parser and the refusal path are
// exercised without a live harness. The real resolver is covered separately
// against the installed binary in posture-opencode.test.ts.
//
// The v2 resolver lists every agent as `{ id, permissions }`, the permission
// name lives in `action`, its pattern in `resource`, and the verdict in
// `effect`. The resolver picks the agent whose `id` matches the one it was
// asked for, so each fixture carries exactly one agent under the name the test
// asks for — except `renamed`, which is built to miss.
const FIXTURES: Record<string, unknown> = {
  build: [
    {
      id: "build",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    },
  ],
  narrow: [
    {
      id: "narrow",
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
    },
  ],
  shellallow: [
    {
      id: "shellallow",
      permissions: [
        { action: "read", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "allow" },
      ],
    },
  ],
  scoped: [
    {
      id: "scoped",
      permissions: [
        { action: "external_directory", resource: "/tmp/*", effect: "allow" },
      ],
    },
  ],
  // Parses as JSON, but it is not the agents array the resolver now emits.
  broken: "not-an-array",
  notjson: "__NOT_JSON__",
  // The cold start: `[]` on the first call, the payload on the second. Only
  // the retry below can reach the payload, so a resolved posture from this
  // fixture is proof the second call happened.
  coldstart: [
    {
      id: "coldstart",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    },
  ],
  // Never has a posture to hand over, so both attempts are spent and the
  // resolve still has to refuse.
  coldempty: [],
  // Populated, but the id inside it is not the one asked for: what a renamed or
  // removed agent looks like to a resolver that selects by id.
  renamed: [
    {
      id: "renamed-away",
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    },
  ],
};

const tempDirs: string[] = [];

function fakeResolver(): {
  command: string;
  attempts: string;
  fixture: (name: string) => NodeJS.ProcessEnv;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "k5-posture-"));
  tempDirs.push(dir);
  const script = path.join(dir, "fake-harness.mjs");
  const attempts = path.join(dir, "attempts");
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const fixtures = JSON.parse(readFileSync(process.env.K5_FIXTURES, "utf8"));
const name = process.env.K5_FIXTURE ?? "build";
if (name === "slow") {
  // Stays alive so the resolver's own timeout is the thing that fires.
  setTimeout(() => process.exit(0), 60000);
} else if (name === "fail") {
  process.stderr.write("boom");
  process.exit(3);
} else if (name === "coldstart" || name === "coldempty") {
  // The harness's cold start: an empty agents array until one call has made it
  // initialise. The attempt count is kept in a file so the test can see how
  // many calls the resolver spent and on which one the payload arrived.
  let attempt = 0;
  try {
    attempt = Number.parseInt(readFileSync(process.env.K5_ATTEMPTS, "utf8"), 10) || 0;
  } catch {}
  writeFileSync(process.env.K5_ATTEMPTS, String(attempt + 1));
  process.stdout.write(JSON.stringify(attempt === 0 ? [] : fixtures[name]));
  process.exit(0);
} else {
  const payload = fixtures[name];
  if (payload === "__NOT_JSON__") {
    process.stdout.write("not json at all");
  } else if (payload === undefined) {
    process.stderr.write("unknown agent: " + name);
    process.exit(1);
  } else {
    process.stdout.write(JSON.stringify(payload));
  }
  process.exit(0);
}
`,
    { mode: 0o755 },
  );
  return {
    // The script itself is the command: the resolver appends `debug agents`
    // and selects the agent from the output itself, so the command must be
    // directly executable rather than a node module path.
    command: script,
    attempts,
    fixture: (name: string) => ({
      ...process.env,
      K5_FIXTURE: name,
      K5_FIXTURES: FIXTURE_FILE,
      K5_ATTEMPTS: attempts,
    }),
  };
}

const FIXTURE_FILE = path.join(tmpdir(), "k5-posture-fixtures.json");
writeFileSync(FIXTURE_FILE, JSON.stringify(FIXTURES));

function probeArgs(name: string) {
  const { command, fixture } = fakeResolver();
  return {
    command,
    cwd: process.cwd(),
    env: fixture(name),
    // The fixture's own agent id: the v2 resolver selects by id, so asking for
    // the fixture's name is what makes each fixture answer for itself.
    agent: name,
    timeoutMs: 5_000,
  };
}

const probe = (name: string) => resolvePosture(probeArgs(name));

const check = (
  name: string,
  profile: "read" | "review" | "full",
) => verifyPosture({ ...probeArgs(name), profile: resolveAccessProfile(profile) });

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(FIXTURE_FILE, { force: true });
});

describe("posture resolution", () => {
  it("detects a blanket wildcard allow", async () => {
    const posture = await probe("build");
    assert.equal(posture.wildcardAllow, true);
    assert.deepEqual(posture.allowedTools, []);
  });

  it("collects named allows and ignores deny/ask rules", async () => {
    const posture = await probe("narrow");
    assert.equal(posture.wildcardAllow, false);
    assert.deepEqual(posture.allowedTools, ["read"]);
  });

  it("does not mistake a scoped allow for a wildcard", async () => {
    const posture = await probe("scoped");
    assert.equal(posture.wildcardAllow, false);
    assert.deepEqual(posture.allowedTools, ["external_directory"]);
  });

  it("reports non-JSON output as unverifiable", async () => {
    await assert.rejects(probe("notjson"), PostureUnverifiableError);
  });

  it("reports a malformed permission array as unverifiable", async () => {
    await assert.rejects(probe("broken"), PostureUnverifiableError);
  });

  it("reports a non-zero exit as unverifiable, not as an empty posture", async () => {
    await assert.rejects(
      probe("fail"),
      (err: unknown) =>
        err instanceof PostureUnverifiableError && /boom|resolver failed/.test(err.message),
    );
  });

  it("reports a missing binary as unverifiable rather than a pass", async () => {
    await assert.rejects(
      resolvePosture({
        command: "definitely-not-a-real-harness-xyz",
        cwd: process.cwd(),
        env: process.env,
        agent: "build",
      }),
      (err: unknown) =>
        err instanceof PostureUnverifiableError && /resolver failed/.test(err.message),
    );
  });

  it("bounds the resolver with its own timeout", async () => {
    await assert.rejects(
      resolvePosture({ ...probeArgs("slow"), timeoutMs: 400 }),
      (err: unknown) =>
        err instanceof PostureUnverifiableError && /timed out/.test(err.message),
    );
  });

  it("spends one retry on a cold start before reading the posture", async () => {
    const { command, attempts, fixture } = fakeResolver();
    const posture = await resolvePosture({
      command,
      cwd: process.cwd(),
      env: fixture("coldstart"),
      agent: "coldstart",
      timeoutMs: 5_000,
    });
    // The payload only exists on the second call, so resolving at all means the
    // empty first answer was retried rather than taken as the posture.
    assert.equal(readFileSync(attempts, "utf8"), "2");
    assert.equal(posture.wildcardAllow, true);
    assert.equal(posture.ruleCount, 1);
  });

  it("reports two empty answers as unverifiable, after spending the retry", async () => {
    const { command, attempts, fixture } = fakeResolver();
    await assert.rejects(
      resolvePosture({
        command,
        cwd: process.cwd(),
        env: fixture("coldempty"),
        agent: "coldempty",
        timeoutMs: 5_000,
      }),
      (err: unknown) =>
        err instanceof PostureUnverifiableError && /no agents to read/.test(err.message),
    );
    // The second call is the point: without it a cold directory would be
    // reported as having no agents after a single unanswered question.
    assert.equal(readFileSync(attempts, "utf8"), "2");
  });

  it("reports an id the resolver does not list as unverifiable", async () => {
    await assert.rejects(
      probe("renamed"),
      (err: unknown) =>
        err instanceof PostureUnverifiableError &&
        /no agent named "renamed"/.test(err.message),
    );
  });
});

describe("posture verification fails closed", () => {
  it("refuses the read profile against a wildcard harness posture", async () => {
    await assert.rejects(
      check("build", "read"),
      (err: unknown) =>
        err instanceof PostureTooWeakError && err.offending.includes("*"),
    );
  });

  it("refuses the read profile when the harness allows shell outright", async () => {
    await assert.rejects(
      check("shellallow", "read"),
      (err: unknown) =>
        err instanceof PostureTooWeakError && err.offending.includes("shell"),
    );
  });

  it("accepts a posture that stays inside the full profile", async () => {
    const posture = await check("narrow", "full");
    assert.equal(posture.wildcardAllow, false);
  });

  it("tolerates an ask, because the k5 gate decides asks at request time", async () => {
    // `narrow` allows only read and *asks* for shell. The read profile permits
    // asks, so the posture is acceptable; enforcement is the gate's job.
    const posture = await check("narrow", "read");
    assert.deepEqual(posture.allowedTools, ["read"]);
  });

  it("refuses to guess when the posture is unreadable, except for full", async () => {
    const missing = {
      command: "definitely-not-a-real-harness-xyz",
      cwd: process.cwd(),
      env: process.env,
      agent: "build",
    };
    await assert.rejects(
      verifyPosture({ ...missing, profile: resolveAccessProfile("review") }),
      PostureUnverifiableError,
    );
    // `full` promises nothing narrower than the harness default, so there is no
    // gap for an unreadable posture to hide behind.
    const posture = await verifyPosture({
      ...missing,
      profile: resolveAccessProfile("full"),
    });
    assert.equal(posture.wildcardAllow, true);
  });
});
