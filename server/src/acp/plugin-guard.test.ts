import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { describeFinding, findPluginSignals } from "./plugin-guard.js";

const roots: string[] = [];

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "k5-plugin-guard-"));
  roots.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("plugin guard", () => {
  it("finds nothing in a plain project", () => {
    const dir = project();
    writeFileSync(path.join(dir, "README.md"), "# hi");
    assert.deepEqual(findPluginSignals(dir), []);
  });

  it("refuses a plugins directory and names the path", () => {
    const dir = project();
    const plugins = path.join(dir, ".opencode", "plugin");
    mkdirSync(plugins, { recursive: true });
    const found = findPluginSignals(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].signal, "opencode-plugins-dir");
    assert.match(describeFinding(found[0]), /OpenCode plugins/);
    assert.match(describeFinding(found[0]), /plugin/);
  });

  it("accepts the plural directory spelling too", () => {
    const dir = project();
    mkdirSync(path.join(dir, ".opencode", "plugins"), { recursive: true });
    assert.equal(findPluginSignals(dir)[0].signal, "opencode-plugins-dir");
  });

  it("refuses project-supplied agent definitions", () => {
    const dir = project();
    mkdirSync(path.join(dir, ".opencode", "agent"), { recursive: true });
    const found = findPluginSignals(dir);
    assert.equal(found[0].signal, "opencode-agents-dir");
  });

  it("refuses an opencode.json that declares a plugin", () => {
    for (const plugin of ['["a"]', '"a"', '{ "b": {} }']) {
      const dir = project();
      writeFileSync(
        path.join(dir, "opencode.json"),
        JSON.stringify({ plugin: JSON.parse(plugin) }),
      );
      const found = findPluginSignals(dir);
      assert.equal(found[0]?.signal, "opencode-json-plugin", `failed for ${plugin}`);
    }
  });

  it("allows an opencode.json with an empty or absent plugin key", () => {
    for (const body of [
      { plugin: [] },
      { plugin: "" },
      { plugin: {} },
      { theme: "dark" },
    ]) {
      const dir = project();
      writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(body));
      assert.deepEqual(findPluginSignals(dir), [], `failed for ${JSON.stringify(body)}`);
    }
  });

  it("catches a plugin declared in a commented jsonc config", () => {
    const dir = project();
    writeFileSync(
      path.join(dir, "opencode.jsonc"),
      `{
        // a comment makes this invalid strict JSON
        "theme": "dark",
        "plugin": ["./evil.ts"]
      }`,
    );
    const found = findPluginSignals(dir);
    assert.equal(found[0]?.signal, "opencode-json-plugin");
  });

  it("does not treat the word plugin inside a string as a declaration", () => {
    const dir = project();
    writeFileSync(
      path.join(dir, "opencode.json"),
      JSON.stringify({ description: "this project has a plugin loader", theme: "x" }),
    );
    assert.deepEqual(findPluginSignals(dir), []);
  });

  it("reports every signal it finds, not just the first", () => {
    const dir = project();
    mkdirSync(path.join(dir, ".opencode", "plugin"), { recursive: true });
    writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ plugin: ["a"] }));
    const signals = findPluginSignals(dir).map((f) => f.signal).sort();
    assert.deepEqual(signals, ["opencode-json-plugin", "opencode-plugins-dir"]);
  });

  it("refuses a config too large to check, rather than passing it", () => {
    // A 2 MiB opencode.json is ordinary (long MCP inventories), so treating
    // "too large" as "nothing to find" would be a plausible bypass.
    const dir = project();
    writeFileSync(path.join(dir, "opencode.json"), "x".repeat(2 * 1024 * 1024));
    const found = findPluginSignals(dir);
    assert.equal(found[0]?.signal, "opencode-json-unreadable");
    assert.match(describeFinding(found[0]), /could not be checked/);
  });

  it("does not treat a directory named opencode.json as a config", () => {
    const dir = project();
    mkdirSync(path.join(dir, "opencode.json"), { recursive: true });
    assert.deepEqual(findPluginSignals(dir), []);
  });
});
