import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { client, PROTOCOL_VERSION, type InitializeRequest } from "@agentclientprotocol/sdk";
import type { AttachmentManifestEntry } from "@k5-work/shared";
import { AcpSeat, type SeatStreamEvent } from "./acp-seat.js";
import { probeCapabilities, type AcpCapabilities } from "./capabilities.js";
import { planPromptBlocks } from "./prompt-blocks.js";
import { pinModelIn } from "./real-harness-config.js";
import { spawnAcpChild, type AcpChild } from "./spawn.js";
import { SessionStore } from "../store/session-store.js";

// Ground truth against the real binary, for the three things that until now had
// only ever been exercised against fake-agent.ts: what OpenCode advertises, what
// planPromptBlocks emits under exactly those capabilities, and whether a listed
// session can be adopted and then prompted.
//
// The capability assertion below is the load-bearing one in this file.
// prompt-blocks.ts refuses the whole turn with `no-embedded-context` when the
// harness does not advertise embedded context, and it never emits a
// `resource_link`, because k5 advertises fs.readTextFile: false and a link is a
// path the harness has no way to open. So this one boolean is the difference
// between attachments working on the primary harness and attachments not
// existing there. It is asserted as the value measured against the real binary,
// not as whatever the binary happens to say on the day.
//
// This file found a real bug while being written: a turn the harness answered with
// end_turn after 6.8s and 16.4s came back as "cancelled", with the seat poisoned,
// because acp-seat.ts armed its 5s drain at the start of every turn instead of
// after a cancel. That is fixed, and the fix is proved against the real binary in
// slow-turn-opencode.test.ts. The last test below now asserts a real terminal stop
// rather than recording whatever the day produced.

const OPENCODE_ARGV = ["opencode", "acp"];
// A cold `session/new` against a real harness routinely takes tens of seconds.
const OPEN_TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 180_000;

const TEXT_ID = "att-text-1";
const IMAGE_ID = "att-img-1";
const PROMPT_TEXT = "What is on the attached checklist?";

/**
 * A decodable 1x1 PNG, not a signature fragment.
 *
 * This is a load-bearing fixture choice, measured against real OpenCode 2.0.24:
 * a resource block whose blob is not a decodable image comes back as a JSON-RPC
 * -32603 "OpenCode service failure" (data.service "session"), and the user's
 * text goes down with it. The four-byte fragment in prompt-blocks.test.ts is the
 * right fixture for asserting the base64 encoding and the wrong one for putting
 * a real turn on the wire.
 */
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const ATTACHMENT_TEXT = "release checklist: zeppelin-4711-mango\n";

function opencodeRunnable(): boolean {
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

function requireOpencode(t: TestContext): boolean {
  if (opencodeRunnable()) return true;
  t.skip("opencode is not runnable here, so there is no real harness to assert against");
  return false;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${what} was not a JSON object, so nothing can be read off it`,
  );
  return value as Record<string, unknown>;
}

// --- the raw initialize handshake, memoised so one child answers for the file ---

interface RawProbe {
  /** The initialize response exactly as the SDK handed it over, unparsed. */
  readonly raw: unknown;
  readonly pid: number | undefined;
  readonly reaped: boolean;
}

let rawProbePromise: Promise<RawProbe> | null = null;

/**
 * `initialize` and nothing else: no session, so this is the cheapest possible
 * contact with the binary and it cannot be affected by the model provider.
 *
 * The response is kept raw on purpose. The SDK never validates the client-side
 * initialize response, so this is exactly the object `probeCapabilities` sees in
 * production, and it is the only way to report what the harness advertised rather
 * than what k5 made of it.
 */
async function probeOnce(): Promise<RawProbe> {
  const cwd = mkdtempSync(path.join(tmpdir(), "k5-raw-"));
  const child = await spawnAcpChild({ argv: OPENCODE_ARGV, cwd });
  const pid = child.pid;

  const runInitialize = async (): Promise<unknown> => {
    // Typed const: the SDK infers its per-method param type from the
    // initializer's shape, and an inline literal defeats that inference.
    const initializeParams: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      // The same advertisement acp-seat.ts makes, and load-bearing for what
      // follows: it is why no `resource_link` is ever emitted, so a probe
      // advertising more would not be probing what k5 probes.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
      },
      clientInfo: { name: "k5-work", version: "0.1.0" },
    };
    return client({ name: "k5-work" }).connectWith(
      child.stream,
      async (ctx) =>
        ctx.request("initialize", initializeParams, {
          cancellationSignal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
        }),
    );
  };

  // Both paths reap by the pid captured at spawn. No name or pattern matching:
  // this agent's own argv carries the worktree path.
  let observed: unknown = null;
  let failure: unknown = null;
  try {
    observed = await runInitialize();
  } catch (err) {
    failure = err;
  }
  const closed = await child.close();
  rmSync(cwd, { recursive: true, force: true });
  if (observed === null) {
    throw failure instanceof Error
      ? failure
      : new Error(`the initialize handshake against the real harness failed: ${String(failure)}`);
  }
  return { raw: observed, pid, reaped: closed.reaped };
}

function rawInitialize(): Promise<RawProbe> {
  rawProbePromise ??= probeOnce();
  return rawProbePromise;
}

// --- the real rig: a real store, a real harness session, a real adoption ---

interface Rig {
  readonly store: SessionStore;
  readonly storeRoot: string;
  readonly harnessCwd: string;
  readonly textManifest: AttachmentManifestEntry;
  readonly imageManifest: AttachmentManifestEntry;
  readonly textBytes: Buffer;
  readonly imageBytes: Buffer;
  /** The id a real `session/new` created, which a continuation then adopts. */
  readonly createdSessionId: string;
  readonly seat: AcpSeat;
  readonly child: AcpChild;
  readonly forwarded: string[];
  readonly seatAPid: number | undefined;
  readonly seatAReaped: boolean;
}

let rigPromise: Promise<Rig> | null = null;

function buildRig(): Promise<Rig> {
  rigPromise ??= (async () => {
    // A real store on a real path, so the leak check has genuinely spooled bytes
    // under a genuine root to assert the absence of.
    const storeRoot = mkdtempSync(path.join(tmpdir(), "k5-attach-store-"));
    const store = new SessionStore({ root: storeRoot, onError: () => {} });
    await store.open();
    // A real working directory for the harness, deliberately not the store's, so
    // a path leak cannot hide behind the two being the same string.
    const harnessCwd = mkdtempSync(path.join(tmpdir(), "k5-attach-cwd-"));
    // Same reason as the slow-turn file: the turn below runs on a pinned model,
    // not on whatever this machine happens to default to.
    pinModelIn(harnessCwd);

    const k5Session = await store.create({
      harness: "opencode",
      harnessSessionId: "ses_k5_placeholder",
      projectId: "proj-attachments",
      projectName: "k5-work",
      cwd: harnessCwd,
    });

    // Real uploads through the real spool, so the manifests below are derived
    // from the bytes by the store rather than asserted into existence here.
    const textManifest = await store.spoolAttachment(k5Session.storeId, {
      attachmentId: TEXT_ID,
      name: "checklist.txt",
      mimeType: "text/plain",
      bytes: Buffer.from(ATTACHMENT_TEXT, "utf8"),
    });
    const imageManifest = await store.spoolAttachment(k5Session.storeId, {
      attachmentId: IMAGE_ID,
      name: "shot.png",
      mimeType: "image/png",
      bytes: REAL_PNG,
    });
    // Read back off disk rather than reusing the literals, so the planner is
    // handed the bytes a user's upload would actually produce.
    const textBytes = await store.readAttachment(k5Session.storeId, TEXT_ID);
    const imageBytes = await store.readAttachment(k5Session.storeId, IMAGE_ID);

    // The harness session id is created with a real seat first and that seat is
    // reaped. The continuation opens its own short-lived headless seat, which is
    // the shape k5 uses: an adopt must not leave a session behind on every load.
    const childA = await spawnAcpChild({ argv: OPENCODE_ARGV, cwd: harnessCwd });
    const seatAPid = childA.pid;
    const seatA = await AcpSeat.open(
      childA,
      { cwd: harnessCwd, openTimeoutMs: OPEN_TIMEOUT_MS },
      null,
    );
    const createdSessionId = seatA.sessionId;
    await seatA.close();
    const seatAClosed = await childA.close();

    const child = await spawnAcpChild({ argv: OPENCODE_ARGV, cwd: harnessCwd });
    const forwarded: string[] = [];
    const onEvent = (_turnId: string, event: SeatStreamEvent): void => {
      if (event.kind === "text") forwarded.push(event.text);
    };
    const seat = await AcpSeat.openHeadless(
      child,
      { cwd: harnessCwd, openTimeoutMs: OPEN_TIMEOUT_MS, turnTimeoutMs: TURN_TIMEOUT_MS },
      onEvent,
    );

    return {
      store,
      storeRoot,
      harnessCwd,
      textManifest,
      imageManifest,
      textBytes,
      imageBytes,
      createdSessionId,
      seat,
      child,
      forwarded,
      seatAPid,
      seatAReaped: seatAClosed.reaped,
    };
  })();
  return rigPromise;
}

function attachmentsOf(rig: Rig): { manifest: AttachmentManifestEntry; bytes: Buffer }[] {
  return [
    { manifest: rig.textManifest, bytes: rig.textBytes },
    { manifest: rig.imageManifest, bytes: rig.imageBytes },
  ];
}

/** The real plan: the real probed capabilities over the real spooled bytes. */
function realPlan(rig: Rig): ReturnType<typeof planPromptBlocks> {
  return planPromptBlocks({
    text: PROMPT_TEXT,
    attachments: attachmentsOf(rig),
    caps: rig.seat.capabilities,
  });
}

function hasAdoptedSession(seat: AcpSeat): boolean {
  try {
    seat.sessionId;
    return true;
  } catch {
    return false;
  }
}

describe("attachments and session adoption against a real opencode", () => {
  after(async () => {
    const rig = await rigPromise?.catch(() => null);
    if (rig === null || rig === undefined) return;
    await rig.seat.close();
    const closed = await rig.child.close();
    await rig.store.close();
    rmSync(rig.storeRoot, { recursive: true, force: true });
    rmSync(rig.harnessCwd, { recursive: true, force: true });
    // A harness that did not die is a real orphan on the maintainer's machine,
    // so this is asserted rather than logged.
    assert.equal(
      closed.reaped,
      true,
      `harness pid ${String(rig.child.pid)} was not reaped, so a real harness process was left running`,
    );
    assert.equal(rig.seatAReaped, true, `setup harness pid ${String(rig.seatAPid)} was not reaped`);
  });

  it("the real binary advertises embedded context, which gates every attachment", async (t) => {
    if (!requireOpencode(t)) return;
    const raw = await rawInitialize();

    assert.equal(raw.reaped, true, `probe harness pid ${String(raw.pid)} was not reaped`);
    const response = asRecord(raw.raw, "the initialize response");
    assert.equal(
      response["protocolVersion"],
      PROTOCOL_VERSION,
      "a protocol mismatch would fail every later assertion here for the wrong reason",
    );
    const info = asRecord(response["agentInfo"], "agentInfo");
    t.diagnostic(`observed agentInfo: ${JSON.stringify(info)}`);

    // Verbatim, as observed. Not k5's reading of it: the point of this test is
    // the harness's own answer.
    const agent = asRecord(response["agentCapabilities"], "agentCapabilities");
    t.diagnostic(`observed agentCapabilities: ${JSON.stringify(agent, null, 2)}`);

    const prompt = asRecord(agent["promptCapabilities"], "promptCapabilities");
    assert.deepEqual(
      Object.keys(prompt).sort(),
      ["embeddedContext", "image"],
      "the set of prompt capabilities the real harness advertises changed",
    );
    // The answer the whole attachment path rests on. Measured: true.
    assert.equal(
      prompt["embeddedContext"],
      true,
      "real OpenCode no longer advertises embedded context, so prompt-blocks.ts now refuses every attachment on the primary harness; this is not fixable inside prompt-blocks.ts",
    );
    assert.equal(prompt["image"], true, "real OpenCode stopped advertising image prompt support");

    assert.equal(agent["loadSession"], true, "observed loadSession");
    const sessions = asRecord(agent["sessionCapabilities"], "sessionCapabilities");
    // `fork`, `delete` and `additionalDirectories` are advertised and k5 reads
    // none of them, so they are named here rather than silently ignored: a
    // harness that drops `resume` takes away session adoption, and one that
    // drops `close` takes away the deliberate session close.
    assert.deepEqual(
      Object.keys(sessions).sort(),
      ["additionalDirectories", "close", "delete", "fork", "list", "resume"],
      "the set of session capabilities the real harness advertises changed",
    );

    // And the lenient probe reads that same response as fully capable. If this
    // ever disagrees with the assertions above, capabilities.ts is misreading a
    // shape the harness really sends, which is the failure mode that used to be
    // silent. It gets the whole response, not the capabilities alone, because
    // that is what acp-seat.ts hands it.
    const probed: AcpCapabilities = probeCapabilities(raw.raw);
    assert.equal(probed.embeddedContext, true);
    assert.equal(probed.image, true);
    assert.equal(probed.loadSession, true);
    assert.equal(probed.resume, true);
    assert.equal(probed.close, true);
    assert.deepEqual(
      [...probed.mismatches],
      [],
      "every advertised capability is a shape capabilities.ts can read",
    );
  });

  it("plans the real attachments into the exact blocks those capabilities allow", async (t) => {
    if (!requireOpencode(t)) return;
    const rig = await buildRig();

    // The real store's own verdicts on these bytes, so a change in how it
    // classifies them shows up here rather than as a mystery block.
    assert.equal(rig.textManifest.kind, "text");
    assert.equal(rig.textManifest.mimeType, "text/plain");
    assert.equal(rig.textManifest.size, 39);
    assert.equal(rig.imageManifest.kind, "image");
    assert.equal(rig.imageManifest.mimeType, "image/png");
    assert.equal(rig.imageManifest.size, 70);

    const plan = realPlan(rig);

    // Nothing is refused, because the real harness advertises embedded context.
    // If that ever flips, these blocks are the ones that must disappear, and the
    // first test in this file is the one that goes red.
    assert.deepEqual(plan.refused, []);
    assert.deepEqual(plan.blocks, [
      { type: "text", text: PROMPT_TEXT },
      {
        type: "text",
        text:
          "Attached files:\n- checklist.txt (text/plain, 39 bytes)\n" +
          "- shot.png (image/png, 70 bytes)\n",
      },
      {
        type: "resource",
        resource: {
          uri: "k5-attachment:att-text-1",
          text: ATTACHMENT_TEXT,
          mimeType: "text/plain",
        },
      },
      {
        type: "resource",
        resource: {
          uri: "k5-attachment:att-img-1",
          blob: REAL_PNG.toString("base64"),
          mimeType: "image/png",
        },
      },
    ]);

    // The image payload is the spooled bytes and not a re-encoding of them.
    const image = plan.blocks[3];
    assert.equal(image?.type, "resource");
    const blob = (image as { resource: { blob: string } }).resource.blob;
    assert.deepEqual(Buffer.from(blob, "base64"), rig.imageBytes);

    // `resource_link` is never emitted, and this is the reason: k5 advertises no
    // fs.readTextFile, so a link is an attachment that delivers nothing.
    assert.equal(
      plan.blocks.some((block) => block.type === "resource_link"),
      false,
      "a resource_link would be a path the harness cannot open",
    );
  });

  it("never puts the store's path, or any file:// URI, into a block", async (t) => {
    if (!requireOpencode(t)) return;
    const rig = await buildRig();
    const plan = realPlan(rig);

    // The store root and the session directory are real, populated paths here,
    // so this is checking a leak that could actually happen rather than a string
    // that was never anywhere near the plan.
    assert.ok(rig.storeRoot.startsWith("/"));
    const serialized = plan.blocks.map((block) => JSON.stringify(block));

    for (const block of serialized) {
      assert.equal(
        block.includes(rig.storeRoot),
        false,
        "a prompt block carried the attachment store's root path",
      );
      assert.equal(block.includes(rig.harnessCwd), false, "a prompt block carried the project cwd");
      assert.equal(block.includes("file://"), false, "a prompt block carried a file:// URI");
      assert.equal(block.includes("/tmp/"), false, "a prompt block carried an absolute path");
    }

    // Every resource is addressed by the k5-minted, opaque handle.
    for (const block of plan.blocks) {
      if (block.type !== "resource") continue;
      const uri = (block as { resource: { uri: string } }).resource.uri;
      assert.equal(uri, `k5-attachment:${uri.slice("k5-attachment:".length)}`);
      assert.match(uri, /^k5-attachment:[A-Za-z0-9-]+$/);
    }
  });

  it("adopts the session a real session/new created", async (t) => {
    if (!requireOpencode(t)) return;
    const rig = await buildRig();
    const { seat } = rig;

    // The adopt: session/resume of a stored session.
    const adopted = await seat.adopt(rig.createdSessionId);
    assert.equal(adopted.sessionId, rig.createdSessionId, "the response carries no id, so it is ours");
    assert.ok(
      adopted.configOptions.length > 0,
      "the real harness sends its model and mode options back on resume",
    );
    assert.ok(
      adopted.configOptions.some((option) => option.id === "model"),
      `expected the real harness to offer a model option, got ${JSON.stringify(adopted.configOptions.map((o) => o.id))}`,
    );
    assert.equal(seat.sessionId, rig.createdSessionId, "the seat is now on the adopted session");
    assert.equal(seat.busy, false);
    assert.equal(seat.poisoned, false, "an adoption must not poison the seat");

    // The seat is genuinely attached now, which is the state a prompt needs. A
    // second adopt is refused, so this is evidence and not just a return value.
    await assert.rejects(
      () => seat.adopt(rig.createdSessionId),
      /already has a session/,
    );
  });

  it("prompts the adopted real session once and records the provider's state", async (t) => {
    if (!requireOpencode(t)) return;
    const rig = await buildRig();
    const { seat } = rig;

    // Self-sufficient, so this test does not depend on the one above having run
    // or having passed.
    if (!hasAdoptedSession(seat)) await seat.adopt(rig.createdSessionId);
    const plan = realPlan(rig);
    assert.equal(plan.blocks.length, 4, "the prompt really does carry both attachments");

    // This turn asserts nothing about the model's answer, on purpose. What the
    // model says is the provider's business, and a suite that asserts it would go
    // red whenever the provider is unwell and tell nobody about this code. What is
    // asserted is the part k5 owns: a terminal state, and a seat that is not left
    // holding a turn afterwards.
    let stop: string;
    try {
      stop = await seat.prompt("t-real-prompt", plan.blocks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = rig.child.stderrTail().trim();
      t.skip(
        `the configured model provider refused the turn before any answer: ${message}` +
          (stderr.length > 0 ? ` | harness stderr: ${stderr.slice(-400)}` : "") +
          " -- this is the provider's state, not a contract of this code, and is not asserted either way",
      );
      return;
    }

    t.diagnostic(`observed stopReason on a real prompt with both attachments: ${stop}`);
    t.diagnostic(
      `observed ${String(rig.forwarded.length)} forwarded text chunk(s), ` +
        `seat poisoned=${String(seat.poisoned)}`,
    );

    // A real turn must reach a real terminal stop. This branch used to skip on
    // "cancelled", documenting the seat's own five-second drain as if it were the
    // provider's state. It was k5 killing healthy turns, it is fixed, and a skip
    // that excuses a fixed bug is how the same bug survives a second time.
    assert.notEqual(stop, "cancelled", "a turn that was never cancelled must not settle as cancelled");
    assert.notEqual(stop, "", "the turn reported no stop reason");
    assert.equal(seat.busy, false, "the seat still holds a turn after a terminal stop reason");
  });
});
