import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { strFromU8, unzipSync } from "fflate";
import { PptxPresentationSchema } from "@k5-work/shared";
import { validateSpec, validateZipBytes } from "../ooxml-core/validate.js";
import { findLibreOffice } from "../ooxml-core/libreoffice.js";
import { buildPptx, buildPackageSpec } from "./driver.js";
import {
  CORE_PART,
  LAYOUT_PART,
  MAIN_PART,
  MASTER_PART,
  SLIDE_CT,
  THEME_PART,
} from "./names.js";
import { slidePart } from "./names.js";

const SAMPLE = { title: "Revenue", author: "kriday", slides: [{ title: "Revenue", body: "Up 12 percent" }] };

function entriesOf(bytes: Uint8Array): Record<string, string> {
  const raw = unzipSync(bytes);
  return Object.fromEntries(Object.entries(raw).map(([name, data]) => [name, strFromU8(data)]));
}

describe("pptx driver", () => {
  it("writes a package whose every part is reachable", () => {
    const bytes = buildPptx(SAMPLE);
    const entries = entriesOf(bytes);
    assert.ok(entries[MAIN_PART]);
    assert.ok(entries["ppt/slides/slide1.xml"]);
    const spec = buildPackageSpec(PptxPresentationSchema.parse(SAMPLE));
    assert.deepEqual(validateSpec(spec, { mainPart: MAIN_PART }), { ok: true, errors: [], warnings: [] });
    assert.deepEqual(validateZipBytes(bytes, { mainPart: MAIN_PART }), { ok: true, errors: [], warnings: [] });
  });

  it("refuses a presentation that is not valid, at the boundary", () => {
    assert.throws(() => buildPptx({ slides: [] }));
    assert.throws(() => buildPptx({ slides: [{ title: "" }] }));
  });

  it("is deterministic", () => {
    const first = buildPptx(SAMPLE);
    const second = buildPptx(SAMPLE);
    assert.deepEqual([...first], [...second]);
  });

  it("opens in LibreOffice", (t) => {
    const command = findLibreOffice();
    if (command === undefined) {
      t.skip("LibreOffice executable not found");
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "k5-pptx-gate-"));
    try {
      const input = path.join(root, "presentation.pptx");
      const outdir = path.join(root, "out");
      const profile = path.join(root, "profile");
      fs.writeFileSync(input, buildPptx(SAMPLE));
      fs.mkdirSync(outdir, { recursive: true });
      fs.mkdirSync(profile, { recursive: true });
      const result = spawnSync(
        command,
        ["--headless", "--nologo", "--nodefault", "--norestore", "--nolockcheck", "--nofirststartwizard", `-env:UserInstallation=file://${profile}`, "--convert-to", "fodp", "--outdir", outdir, input],
        { encoding: "utf8", timeout: 60000 },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      assert.equal(result.status, 0, output);
      assert.doesNotMatch(output, /could not be loaded|repair|corrupt/i);
      assert.ok(fs.existsSync(path.join(outdir, "presentation.fodp")));
      const fodp = fs.readFileSync(path.join(outdir, "presentation.fodp"), "utf8");
      assert.match(fodp, /Revenue/);
      assert.match(fodp, /Up 12 percent/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
