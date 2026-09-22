import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { OoxmlError } from "./errors.js";
import { PINNED_MTIME, ZipWriter } from "./zip.js";

// Minimal header walkers: local entries keep the writer honest about
// methods {0,8}, bit3=0, bit11=1; the central scan asserts the same copy.
interface EntryOpt {
  readonly flag: number;
  readonly method: number;
}

function localEntries(zip: Uint8Array): Map<string, EntryOpt> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
  const out = new Map<string, EntryOpt>();
  let o = 0;
  for (;;) {
    const sig = dv.getUint32(o, true);
    if (sig === 0x06054b50 || sig === 0x02014b50) return out;
    assert.equal(sig, 0x04034b50, `local sig at ${o}`);
    const flag = dv.getUint16(o + 6, true);
    const method = dv.getUint16(o + 8, true);
    const compSize = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const name = Buffer.from(zip.subarray(o + 30, o + 30 + nameLen)).toString(
      "utf8",
    );
    out.set(name, { flag, method });
    o += 30 + nameLen + extraLen + compSize;
  }
}

function centralEntries(zip: Uint8Array): Map<string, EntryOpt> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
  let o = 0;
  while (dv.getUint32(o, true) === 0x04034b50) {
    o +=
      30 +
      dv.getUint16(o + 26, true) +
      dv.getUint16(o + 28, true) +
      dv.getUint32(o + 18, true);
  }
  const out = new Map<string, EntryOpt>();
  for (;;) {
    const sig = dv.getUint32(o, true);
    if (sig === 0x06054b50) return out;
    assert.equal(sig, 0x02014b50, `central sig at ${o}`);
    const nameLen = dv.getUint16(o + 28, true);
    const extraLen = dv.getUint16(o + 30, true);
    const commentLen = dv.getUint16(o + 32, true);
    const name = Buffer.from(zip.subarray(o + 46, o + 46 + nameLen)).toString(
      "utf8",
    );
    out.set(name, { flag: dv.getUint16(o + 8, true), method: dv.getUint16(o + 10, true) });
    o += 46 + nameLen + extraLen + commentLen;
  }
}

function hasSig(zip: Uint8Array, sig: number): boolean {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
  for (let o = 0; o + 4 <= zip.length; o++) {
    if (dv.getUint32(o, true) === sig) return true;
  }
  return false;
}

describe("ooxml-core zip writer (D-3)", () => {
  it("round-trips content and pins a deterministic mtime", () => {
    const a = new ZipWriter();
    a.add("b.xml", "<b/>");
    a.add("[Content_Types].xml", "<t/>");
    const bytes = a.build();
    const back = unzipSync(bytes);
    assert.deepEqual(Object.keys(back).sort(), [
      "[Content_Types].xml",
      "b.xml",
    ]);
    assert.equal(strFromU8(back["b.xml"]), "<b/>");

    // Insertion order must not leak into the bytes.
    const b = new ZipWriter();
    b.add("[Content_Types].xml", "<t/>");
    b.add("b.xml", "<b/>");
    assert.deepEqual(Buffer.from(b.build()), Buffer.from(bytes));

    // Wall-clock must not leak either: rebuilding pins PINNED_MTIME.
    assert.deepEqual(Buffer.from(a.build()), Buffer.from(bytes));
  });
