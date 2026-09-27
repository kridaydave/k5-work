import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// The whole point of this file is to catch breakage that no behavioural test
// would see. `moduleResolution: "bundler"` accepts an extensionless relative
// import, TypeScript says nothing is wrong, and Node's ESM loader then refuses
// the file at runtime. That only surfaces when something actually imports the
// module, so a suite that never reaches a file will stay green forever.
const distRoot = path.resolve(fileURLToPath(import.meta.url), "..");
const srcRoot = path.resolve(distRoot, "../src");

function walk(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, extension));
    else if (full.endsWith(extension)) out.push(full);
  }
  return out;
}

describe("module graph hygiene", () => {
  it("uses an explicit extension on every relative import", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot, ".ts")) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]*)"/g)) {
        const specifier = match[1];
        if (/\.(js|json|css)$/.test(specifier)) continue;
        offenders.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "Node ESM needs an explicit extension; these would fail at runtime",
    );
  });

  // The strongest available check: actually load the compiled graph. A bad
  // specifier anywhere in the transitive closure throws here.
  it("loads every compiled module except the process entry point", async () => {
    const files = walk(distRoot, ".js").filter((f) => !f.endsWith(".test.js"));
    assert.ok(
      files.length > 10,
      `expected a real module graph to load, saw ${String(files.length)}`,
    );

    const skipped: string[] = [];
    const failures: string[] = [];
    for (const file of files) {
      // The server entry point binds a port and installs signal handlers on
      // import, so it is covered by the boot smoke tests instead. Matched by
      // path, not basename: ooxml-core/index.js is an ordinary safe module.
      if (path.relative(distRoot, file) === "index.js") {
        skipped.push(file);
        continue;
      }
      try {
        await import(`file://${file}`);
      } catch (err) {
        failures.push(`${path.relative(distRoot, file)}: ${(err as Error).message}`);
      }
    }
    assert.deepEqual(
      skipped.map((f) => path.relative(distRoot, f)),
      ["index.js"],
      "only the server entry point may be skipped",
    );
    assert.deepEqual(failures, [], "every compiled module must be importable");
  });
});
