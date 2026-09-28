// Typed store errors. Codes stay stable so tests assert on a code rather than
// on a message substring, which is the same contract ooxml-core/errors.ts keeps.

export type SessionStoreErrorCode =
  | "E_STORE_PATH_ESCAPE"
  | "E_STORE_META_CORRUPT"
  | "E_STORE_CORRUPT_RECORD"
  | "E_STORE_CORRUPT_LOG"
  | "E_STORE_LINE_TOO_LONG"
  | "E_STORE_WRITABLE"
  | "E_STORE_QUOTA"
  | "E_STORE_EVICTED"
  | "E_STORE_UNKNOWN_SESSION"
  | "E_STORE_ROOT";

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SessionStoreError";
    this.code = code;
  }
}
