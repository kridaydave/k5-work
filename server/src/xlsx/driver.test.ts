import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import {
  XlsxWorkbookSchema,
} from "@k5-work/shared";
import { validateSpec, validateZipBytes } from "../ooxml-core/validate.js";
import { MAX_XML_ELEMENTS } from "../ooxml-core/index.js";
import { findLibreOffice } from "../ooxml-core/libreoffice.js";
import { buildXlsx, buildPackageSpec } from "./driver.js";
import { CORE_PART, MAIN_PART, SHARED_STRINGS_PART, STYLES_PART } from "./names.js";

const SAMPLE = {
  title: "Revenue",
  author: "kriday",
  sheets: [
    {
      name: "Sheet1",
      rows: [
        [{ value: "Quarter" }, { value: "Total" }],
        [{ value: "Q1" }, { value: 42 }],
        [{ value: true }, { value: null }],
      ],
    },
  ],
} as const;

function entriesOf(bytes: Uint8Array): Record<string, string> {
  const raw = unzipSync(bytes);
  return Object.fromEntries(Object.entries(raw).map(([name, data]) => [name, strFromU8(data)]));
}

describe("xlsx driver", () => {
  it("writes a package whose parts are reachable", () => {
    const bytes = buildXlsx(SAMPLE);
    const entries = entriesOf(bytes);
    assert.ok(entries["[Content_Types].xml"]);
    assert.ok(entries["_rels/.rels"]);
    assert.ok(entries["xl/_rels/workbook.xml.rels"]);
    assert.ok(entries[MAIN_PART]);
    assert.ok(entries[STYLES_PART]);
    assert.ok(entries[SHARED_STRINGS_PART]);
    assert.ok(entries["xl/worksheets/sheet1.xml"]);
    assert.ok(entries[CORE_PART]);

    const spec = buildPackageSpec(XlsxWorkbookSchema.parse(SAMPLE));
    assert.deepEqual(validateSpec(spec, { mainPart: MAIN_PART }), { ok: true, errors: [], warnings: [] });
    assert.deepEqual(validateZipBytes(bytes, { mainPart: MAIN_PART }), { ok: true, errors: [], warnings: [] });
  });

  it("refuses an invalid workbook at the boundary", () => {
    assert.throws(() => buildXlsx({ sheets: [] }));
    assert.throws(() => buildXlsx({ sheets: [{ name: "a", rows: [] }, { name: "a", rows: [] }] }));
  });

  it("is deterministic", () => {
    const first = buildXlsx(SAMPLE);
    const second = buildXlsx(SAMPLE);
    assert.deepEqual([...first], [...second]);
  });

  it("opens in LibreOffice without repair", (t) => {
    const command = findLibreOffice();
    if (command === undefined) {
      t.skip("LibreOffice executable not found");
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "k5-xlsx-gate-"));
    try {
      const input = path.join(root, "book.xlsx");
      const outdir = path.join(root, "out");
      const profile = path.join(root, "profile");
      fs.writeFileSync(input, buildXlsx(SAMPLE));
      fs.mkdirSync(outdir, { recursive: true });
      fs.mkdirSync(profile, { recursive: true });
      const result = spawnSync(
        command,
        ["--headless", "--nologo", "--nodefault", "--norestore", "--nolockcheck", "--nofirststartwizard", `-env:UserInstallation=${pathToFileURL(profile).href}`, "--convert-to", "csv", "--outdir", outdir, input],
        { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      assert.equal(result.status, 0, output);
      assert.equal(result.signal, null, output);
      assert.doesNotMatch(output, /repair|corrupt|could not be loaded/i);
      assert.ok(fs.existsSync(path.join(outdir, "book.csv")), "no converted file");
      const csv = fs.readFileSync(path.join(outdir, "book.csv"), "utf8");
      assert.match(csv, /Quarter/);
      assert.match(csv, /42/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});