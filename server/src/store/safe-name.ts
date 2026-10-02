// Filesystem-name safety for the session store.
//
// The predicate is deliberately the same shape as ooxml-core/paths.ts, which
// already encodes every hazard: "." and ".." segments, trailing dot or space,
// control characters, bidi and zero-width overrides, Windows device names,
// "__proto__", and colons or drive letters. That module is not imported here —
// it is ZIP/OPC path policy inside an office package, and a server -> ooxml-core
// import would invert the layering module-graph.test.ts guards. One guard, two
// callers, no cross-domain import.

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])$/i;
const UNSAFE_UNICODE = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

export type UnsafeNameReason =
  | "empty"
  | "dot"
  | "dotdot"
  | "trailing"
  | "control"
  | "unsafe-unicode"
  | "device"
  | "proto"
  | "colon"
  | "too-long";

function isWindowsDeviceName(segment: string): boolean {
  const stem = segment.split(".", 1)[0]?.replace(/[ .]+$/g, "") ?? "";
  return WINDOWS_DEVICE_NAME.test(stem);
}

/**
 * Returns the reason a single path segment is refused, or null when it is safe.
 * Callers join only known-safe segments and still assert the result is inside
 * the root, because a predicate plus a join is defence in depth, not proof.
 */
export function unsafeNameReason(
  segment: string,
  options: { readonly maxBytes?: number } = {},
): UnsafeNameReason | null {
  // A NUL byte is not a validation problem: fs throws ERR_INVALID_ARG_VALUE on
  // it, which would surface as a TypeError from deep inside a write.
  if (segment.length === 0) return "empty";
  if (segment === ".") return "dot";
  if (segment === "..") return "dotdot";
  if (segment !== segment.trim()) return "trailing";
  if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing";
  for (const char of segment) {
    const codePoint = char.codePointAt(0) ?? 0;
    // C0 and DEL, plus C1 (U+0080-U+009F), which is what smuggled control
    // sequences into a rendered sidebar row.
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return "control";
  }
  if (UNSAFE_UNICODE.test(segment)) return "unsafe-unicode";
  if (isWindowsDeviceName(segment)) return "device";
  if (segment.toLowerCase() === "__proto__") return "proto";
  // A colon is an NTFS alternate data stream, so "sess:ion" writes a hidden
  // stream on a real file rather than a directory.
  if (segment.includes(":")) return "colon";
  if (/^[A-Za-z]:$/.test(segment)) return "colon";
  const maxBytes = options.maxBytes ?? 255;
  if (Buffer.byteLength(segment, "utf8") > maxBytes) return "too-long";
  return null;
}

export function isSafeNameSegment(
  segment: string,
  options: { readonly maxBytes?: number } = {},
): boolean {
  return unsafeNameReason(segment, options) === null;
}
