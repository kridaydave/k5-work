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
