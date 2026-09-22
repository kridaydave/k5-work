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
