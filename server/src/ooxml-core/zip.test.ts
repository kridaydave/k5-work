import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { OoxmlError } from "./errors.js";
import { PINNED_MTIME, ZipWriter } from "./zip.js";

// Minimal header walkers: local entries keep the writer honest about
// methods {0,8}, bit3=0, bit11=1, CRC and sizes; the central scan asserts
// the same copy.
interface EntryOpt {
  readonly flag: number;
  readonly method: number;
  readonly crc: number;
  readonly comp: number;
  readonly uncomp: number;
}

// Independent CRC32 (IEEE): fflate exposes none, and trusting the library
// under test to check itself would make the CRC asserts vacuous.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
    const crc = dv.getUint32(o + 14, true);
    const comp = dv.getUint32(o + 18, true);
    const uncomp = dv.getUint32(o + 22, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const name = Buffer.from(zip.subarray(o + 30, o + 30 + nameLen)).toString(
      "utf8",
    );
    out.set(name, { flag, method, crc, comp, uncomp });
    o += 30 + nameLen + extraLen + comp;
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
    const crc = dv.getUint32(o + 16, true);
    const comp = dv.getUint32(o + 20, true);
    const uncomp = dv.getUint32(o + 24, true);
    const nameLen = dv.getUint16(o + 28, true);
    const extraLen = dv.getUint16(o + 30, true);
    const commentLen = dv.getUint16(o + 32, true);
    const name = Buffer.from(zip.subarray(o + 46, o + 46 + nameLen)).toString(
      "utf8",
    );
    out.set(name, { flag: dv.getUint16(o + 8, true), method: dv.getUint16(o + 10, true), crc, comp, uncomp });
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

// Positional end-of-archive: walk locals then centrals and require the
// EOCD to be the terminal 22-byte record. hasSig alone could false-match
// on compressed payload bytes, so structure beats scanning here.
function assertEndsAtPlainEocd(zip: Uint8Array): void {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.length);
  let o = 0;
  let locals = 0;
  while (dv.getUint32(o, true) === 0x04034b50) {
    locals++;
    o +=
      30 +
      dv.getUint16(o + 26, true) +
      dv.getUint16(o + 28, true) +
      dv.getUint32(o + 18, true);
  }
  let centrals = 0;
  while (dv.getUint32(o, true) === 0x02014b50) {
    centrals++;
    o +=
      46 +
      dv.getUint16(o + 28, true) +
      dv.getUint16(o + 30, true) +
      dv.getUint16(o + 32, true);
  }
  assert.equal(dv.getUint32(o, true), 0x06054b50, "EOCD terminates archive");
  assert.equal(o + 22, zip.length, "EOCD is the final record");
  assert.equal(centrals, locals, "central/local entry count agrees");
  assert.ok(!hasSig(zip.subarray(o), 0x06064b50), "no ZIP64 EOCD");
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

  it("emits methods {0,8} with bit3=0 and bit11=1 everywhere", () => {
    const w = new ZipWriter();
    w.add("[Content_Types].xml", "<t/>");
    w.add("word/document.xml", "<d/>");
    w.add("word/media/img.png", new Uint8Array([1, 2, 3]), { level: 0 });
    w.add("ünïcode/n.xml", "<u/>");
    const bytes = w.build();

    const locals = localEntries(bytes);
    assert.equal(locals.get("word/document.xml")?.method, 8);
    assert.equal(locals.get("word/media/img.png")?.method, 0);
    const back = unzipSync(bytes);
    for (const [name, e] of locals) {
      assert.equal(e.flag & 0x0008, 0, `bit3 set on ${name}`);
      assert.equal(e.flag & 0x0800, 0x0800, `bit11 clear on ${name}`);
      assert.ok(e.method === 0 || e.method === 8, `method on ${name}`);
      // CRC is over the UNCOMPRESSED bytes: recompute independently and
      // require both header copies to agree with it.
      assert.equal(e.crc, crc32(back[name]), `crc mismatch on ${name}`);
      assert.equal(e.uncomp, back[name].length, `size mismatch on ${name}`);
    }
    // Central copies carry the same UTF-8 declaration and methods.
    const centrals = centralEntries(bytes);
    for (const [name, e] of centrals) {
      assert.equal(e.flag & 0x0800, 0x0800, `central bit11 clear on ${name}`);
      const local = locals.get(name);
      assert.equal(e.method, local?.method, `central/local method mismatch on ${name}`);
      assert.equal(e.crc, local?.crc, `central/local crc mismatch on ${name}`);
      assert.equal(e.comp, local?.comp, `central/local comp mismatch on ${name}`);
      assert.equal(e.uncomp, local?.uncomp, `central/local uncomp mismatch on ${name}`);
    }
    // Canonical order falls out of the sort: table, rels-ish, parts.
    assert.deepEqual([...locals.keys()], [
      "[Content_Types].xml",
      "word/document.xml",
      "word/media/img.png",
      "ünïcode/n.xml",
    ]);
  });

  it("never emits ZIP64 and always ends at a plain EOCD", () => {
    const w = new ZipWriter();
    w.add("a.xml", "<a/>");
    w.add("b.xml", "<b/>");
    const bytes = w.build();
    assertEndsAtPlainEocd(bytes);
  });

  it("normalizes paths and refuses escapes, drives, and dirs", () => {
    const w = new ZipWriter();
    w.add("/leading/slash.xml", "<a/>");
    w.add("back\\slash.xml", "<b/>");
    const back = unzipSync(w.build());
    assert.ok(Object.hasOwn(back, "leading/slash.xml"));
    assert.ok(Object.hasOwn(back, "back/slash.xml"));

    for (const bad of [
      "../evil.xml",
      "a/../../evil.xml",
      "C:/evil.xml",
      "C:\\evil.xml",
      "",
      "a//b.xml",
      "word/",
    ]) {
      assert.throws(
        () => new ZipWriter().add(bad, "<x/>"),
        (e: unknown) => e instanceof OoxmlError,
        bad,
      );
    }
  });

  it("uses ASCII-only case folding for ZIP names", () => {
    const writer = new ZipWriter();
    writer.add("word/Ä.xml", "<a/>");
    writer.add("word/ä.xml", "<b/>");
    assert.deepEqual(Object.keys(unzipSync(writer.build())).sort(), [
      "word/Ä.xml",
      "word/ä.xml",
    ]);
  });

  it("refuses duplicate entries case-insensitively and bad levels", () => {
    const w = new ZipWriter();
    w.add("word/Doc.xml", "<a/>");
    assert.throws(
      () => w.add("WORD/doc.xml", "<b/>"),
      (e: unknown) =>
        e instanceof OoxmlError && e.code === "E_PACKAGE_DUP_PART",
    );
    for (const level of [-1, 10, 2.5, Number.NaN]) {
      assert.throws(
        () => new ZipWriter().add("a.xml", "<x/>", { level }),
        (e: unknown) => e instanceof OoxmlError && e.code === "E_ZIP_METHOD",
        `level ${String(level)}`,
      );
    }
  });

  it("honors an explicit mtime override and copies input bytes", () => {
    const custom = new Date(Date.UTC(2021, 5, 15));
    const a = new ZipWriter();
    a.add("a.xml", "<a/>", { mtime: custom });
    const b = new ZipWriter();
    b.add("a.xml", "<a/>");
    assert.notDeepEqual(Buffer.from(a.build()), Buffer.from(b.build()));

    const raw = new Uint8Array([9, 9, 9]);
    const w = new ZipWriter();
    w.add("r.bin", raw, { level: 0 });
    raw[0] = 1;
    assert.equal(unzipSync(w.build())["r.bin"][0], 9);

    // Buffer.slice() is a VIEW, not a copy: the writer must copy through
    // the prototype so caller mutations cannot leak into the build.
    const buf = Buffer.from([7, 7, 7]);
    const wb = new ZipWriter();
    wb.add("s.bin", buf, { level: 0 });
    buf[0] = 2;
    assert.equal(unzipSync(wb.build())["s.bin"][0], 7);
  });

  it("pins a timezone-proof mtime by default", () => {
    // Mid-month noon UTC: local calendar stays in range 1980-2099 for
    // every real timezone (fflate encodes local fields, not the instant).
    assert.equal(PINNED_MTIME.getTime(), Date.UTC(2001, 5, 15, 12, 0, 0));
    const y = PINNED_MTIME.getFullYear();
    assert.ok(y === 2000 || y === 2001, `local year near pin: ${y}`);
  });

  it("refuses __proto__ names instead of corrupting the map", () => {
    for (const bad of ["__proto__", "__PROTO__", "a/__proto__"]) {
      assert.throws(
        () => new ZipWriter().add(bad, "<x/>"),
        (e: unknown) => e instanceof OoxmlError && e.code === "E_ZIP_PATH",
        bad,
      );
    }
  });

  it("is immune to caller-mutated mtimes after add()", () => {
    const custom = new Date(Date.UTC(2021, 5, 15));
    const w = new ZipWriter();
    w.add("a.xml", "<a/>", { mtime: custom });
    const before = Buffer.from(w.build());
    custom.setTime(Date.UTC(2022, 1, 1));
    assert.deepEqual(Buffer.from(w.build()), before);
  });

  it("refuses wrong-typed data and mtimes with typed errors", () => {
    const isFormat = (e: unknown) =>
      e instanceof OoxmlError && e.code === "E_ZIP_FORMAT";
    for (const data of [12345, null, undefined, { raw: "<a/>" }]) {
      assert.throws(
        () =>
          new ZipWriter().add("a.xml", data as unknown as Uint8Array, {
            level: 0,
          }),
        isFormat,
        `data ${String(data)}`,
      );
    }
    for (const mtime of ["2021-01-01", 12345, null]) {
      assert.throws(
        () =>
          new ZipWriter().add("a.xml", "<a/>", {
            mtime: mtime as unknown as Date,
          }),
        isFormat,
        `mtime ${String(mtime)}`,
      );
    }
    assert.throws(
      () => new ZipWriter("bad" as unknown as Date),
      isFormat,
      "ctor mtime",
    );
  });

  it("refuses NaN and out-of-range mtimes", () => {
    const isFormat = (e: unknown) =>
      e instanceof OoxmlError && e.code === "E_ZIP_FORMAT";
    for (const mtime of [
      new Date(Number.NaN),
      new Date(Date.UTC(1979, 11, 31)),
      new Date(Date.UTC(2108, 0, 1)),
    ]) {
      assert.throws(
        () => new ZipWriter().add("a.xml", "<a/>", { mtime }),
        isFormat,
        `mtime ${mtime.getTime()}`,
      );
    }
    assert.throws(
      () => new ZipWriter(new Date(Number.NaN)),
      isFormat,
      "ctor NaN",
    );
  });

  it("refuses to build an empty package", () => {
    assert.throws(
      () => new ZipWriter().build(),
      (e: unknown) => e instanceof OoxmlError && e.code === "E_ZIP_FORMAT",
    );
  });
});