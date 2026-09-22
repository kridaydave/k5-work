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
