// OPC-only ZIP writer for ooxml-core (D-3).
// Narrow writer, not a general zipper: methods {0, 8} only, bit 3 = 0
// (buffer assembly — precomputed CRC/sizes, maximal reader compat),
// bit 11 = 1 on every entry (names are always UTF-8), pinned UTC mtime,
// no ZIP64, no directory entries, deterministic key order.
//
// fflate's zipSync already assembles buffers with bit3=0 and never emits
// ZIP64 at v1 sizes, but it sets bit 11 only for non-ASCII names — so
// build() forces the bit on every local + central entry after packing.
// Sorting is by UTF-8 bytes (not locale, not UTF-16 code units) so bytes
// are identical on every machine. As a side effect the canonical OPC
// order falls out of the sort: "[Content_Types].xml" (0x5B…) first,
// then "_rels/…" (0x5F…), then parts.

import { strToU8, zipSync } from "fflate";
import { OoxmlError } from "./errors.js";
import { toZipPath } from "./paths.js";

// DOS time starts 1980-01-01; pin exactly there (UTC) so builds never
// embed the wall clock. Callers may pass an explicit mtime per entry,
// but the default keeps fixtures byte-identical across runs. Shared and
// mutable by nature (Date) — ZipWriter copies it on entry, so mutating
// this object (or any caller-supplied mtime) after the fact cannot shift
// bytes of writers already constructed. Treat as read-only.
export const PINNED_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
export const DEFAULT_LEVEL = 6;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;

export interface ZipAddOptions {
  // 0 = Store, 1-9 = Deflate. Anything else is refused (E_ZIP_METHOD):
  // OPC allows no other method.
  readonly level?: number;
  readonly mtime?: Date;
}

interface StoredFile {
  readonly data: Uint8Array;
  readonly level: ZipLevel;
  readonly mtime: Date;
}

type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

function assertLevel(level: number): asserts level is ZipLevel {
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new OoxmlError("E_ZIP_METHOD", `bad compression level: ${level}`);
  }
}

// fflate throws an untyped numeric-coded error outside 1980-2099 and
// packs month-0/day-0 bytes for NaN — both escape D-4 code triage, so
// refuse non-Date/NaN/out-of-range mtimes here with a typed error.
function assertMtime(mtime: Date, what: string): void {
  if (!(mtime instanceof Date)) {
    throw new OoxmlError("E_ZIP_FORMAT", `mtime is not a Date for ${what}`);
  }
  const t = mtime.getTime();
  if (
    !Number.isFinite(t) ||
    t < Date.UTC(1980, 0, 1) ||
    t >= Date.UTC(2100, 0, 1)
  ) {
    throw new OoxmlError(
      "E_ZIP_FORMAT",
      `mtime out of range 1980-2099 for ${what}`,
    );
  }
}

function assertBytes(data: Uint8Array, name: string): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new OoxmlError("E_ZIP_FORMAT", `bad data type for entry ${name}`);
  }
  return data.slice();
}

// Byte-wise UTF-8 key: encoded once per name, compared by bytes —
// deterministic on every platform (not locale, not UTF-16 code units).
interface SortKey {
  readonly name: string;
  readonly raw: Uint8Array;
}

function byteCompare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

export class ZipWriter {
  private readonly files = new Map<string, StoredFile>();
  // Lowercased names guard the OPC case-insensitive equivalence rule:
  // "a.xml" + "A.XML" would be one part to a reader, so refuse it here.
  private readonly known = new Set<string>();
  private readonly defaultMtime: Date;

  constructor(defaultMtime: Date = PINNED_MTIME) {
    assertMtime(defaultMtime, "default");
    // Copy: a caller-mutated Date must never shift later builds.
    this.defaultMtime = new Date(defaultMtime.getTime());
  }

  add(path: string, data: Uint8Array | string, opts: ZipAddOptions = {}): void {
    const name = toZipPath(path);
    if (name.endsWith("/")) {
      throw new OoxmlError("E_ZIP_PATH", `directory entries refused: ${path}`);
    }
    const folded = name.toLowerCase();
    if (this.known.has(folded)) {
      throw new OoxmlError("E_PACKAGE_DUP_PART", `duplicate entry: ${name}`);
    }
    const level = opts.level ?? DEFAULT_LEVEL;
    assertLevel(level);
    if (opts.mtime !== undefined) assertMtime(opts.mtime, `entry ${name}`);
    const bytes = typeof data === "string" ? strToU8(data) : assertBytes(data, name);
    this.known.add(folded);
    this.files.set(name, {
      data: bytes,
      level,
      mtime:
        opts.mtime === undefined
          ? this.defaultMtime
          : new Date(opts.mtime.getTime()),
    });
  }

  build(): Uint8Array {
    // A 22-byte EOCD-only zip is valid ZIP but never valid OPC.
    if (this.files.size === 0) {
      throw new OoxmlError("E_ZIP_FORMAT", "empty package refused");
    }
    const keys: SortKey[] = [...this.files.keys()].map((name) => ({
      name,
      raw: strToU8(name),
    }));
    keys.sort((a, b) => byteCompare(a.raw, b.raw));
    // fromEntries (not `{}` + assignment): CreateDataProperty semantics,
    // so a "__proto__" name becomes a safe own property instead of
    // re-pointing the container's prototype. toZipPath refuses the segment
    // anyway — this is the second layer.
    const tuples: Array<[string, [Uint8Array, { level: ZipLevel; mtime: Date }]]> =
      [];
    for (const { name } of keys) {
      const f = this.files.get(name);
      if (f === undefined) {
        // Unreachable without concurrent mutation; dropping an entry
        // silently would violate fail-closed, so throw instead.
        throw new OoxmlError("E_ZIP_FORMAT", "internal entry invariant");
      }
      tuples.push([name, [f.data, { level: f.level, mtime: f.mtime }]]);
    }
    const zippable: Record<
      string,
      [Uint8Array, { level: ZipLevel; mtime: Date }]
    > = Object.fromEntries(tuples);
    try {
      return forceUtf8Flag(zipSync(zippable));
    } catch (e) {
      if (e instanceof OoxmlError) throw e;
      throw new OoxmlError(
        "E_ZIP_FORMAT",
        `pack failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

// ZIP64 markers get their own code; anything else structural (spanning
// markers, digital-signature headers, …) is E_ZIP_FORMAT — valid ZIP the
// OPC-only writer refuses, not ZIP64.
function unexpectedSig(sig: number, where: string): OoxmlError {
  if (sig === ZIP64_EOCD_SIG || sig === ZIP64_LOCATOR_SIG) {
    return new OoxmlError(
      "E_ZIP_ZIP64",
      `ZIP64 ${where} refused: 0x${sig.toString(16)}`,
    );
  }
  return new OoxmlError(
    "E_ZIP_FORMAT",
    `unexpected ZIP signature 0x${sig.toString(16)} in ${where} (refused)`,
  );
}

// fflate sets bit 11 only when the name is non-ASCII. OPC practice is
// UTF-8-always, so set the bit on every entry (local + central copies).
// Walks the structure instead of trusting offsets; anything unexpected
// (data descriptors, ZIP64 markers, unknown signatures) fails closed.
function forceUtf8Flag(zip: Uint8Array): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.length);
  let o = 0;
  for (;;) {
    if (o + 4 > out.length) {
      throw new OoxmlError("E_ZIP_GPBIT", "truncated ZIP while setting bit 11");
    }
    const sig = dv.getUint32(o, true);
    if (sig === EOCD_SIG) return out;
    if (sig === CENTRAL_SIG) break;
    if (sig !== LOCAL_SIG) {
      throw unexpectedSig(sig, "local headers");
    }
    const flag = dv.getUint16(o + 6, true);
    if ((flag & DATA_DESCRIPTOR_FLAG) !== 0) {
      throw new OoxmlError("E_ZIP_GPBIT", "data descriptor refused (bit 3)");
    }
    dv.setUint16(o + 6, flag | UTF8_FLAG, true);
    const compSize = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    o += 30 + nameLen + extraLen + compSize;
  }
  for (;;) {
    if (o + 4 > out.length) {
      throw new OoxmlError("E_ZIP_GPBIT", "truncated central dir");
    }
    const sig = dv.getUint32(o, true);
    if (sig === EOCD_SIG) return out;
    if (sig !== CENTRAL_SIG) {
      throw unexpectedSig(sig, "central directory");
    }
    dv.setUint16(o + 8, dv.getUint16(o + 8, true) | UTF8_FLAG, true);
    const nameLen = dv.getUint16(o + 28, true);
    const extraLen = dv.getUint16(o + 30, true);
    const commentLen = dv.getUint16(o + 32, true);
    o += 46 + nameLen + extraLen + commentLen;
  }
}
