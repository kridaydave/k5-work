import type { ActiveSession, ClientContext } from "@agentclientprotocol/sdk";
import { MAX_LISTED_SESSIONS } from "@k5-work/shared";
import type { SessionInfo } from "@agentclientprotocol/sdk";

// The two pieces of ACP that the SDK does not hand a client, isolated here so
// the seat has one place that reaches past the public API and one place to argue
// about it.

/** A harness-reported session, narrowed and length-bounded. */
export interface HarnessSessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly updatedAt: string | null;
}

export /**
 * The wire caps this at the same number (shared/src/contracts.ts, the 100 on
 * `session.listed.sessions`). Kept as a named import rather than a literal so a
 * change to one is a compile error at the other rather than a silent truncation of
 * the list a user can see.
 */
const MAX_LISTED_HARNESS_SESSIONS = MAX_LISTED_SESSIONS;
const MAX_TITLE_CHARS = 200;

/**
 * `SessionInfo` is harness-controlled and unbounded in the generated types, so
 * every field is checked and capped rather than trusted. A session without a
 * usable id or cwd is unusable to us, so it is dropped rather than half-kept.
 */
export function toHarnessSessionInfo(raw: unknown): HarnessSessionInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const sessionId = entry["sessionId"];
  const cwd = entry["cwd"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  // cwd must be absolute: ACP requires it, and a relative one would make the
  // stored-cwd check meaningless.
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const title = entry["title"];
  const updatedAt = entry["updatedAt"];
  return {
    sessionId: sessionId.slice(0, 256),
    cwd: cwd.slice(0, 4096),
    title: typeof title === "string" && title.length > 0 ? title.slice(0, MAX_TITLE_CHARS) : null,
    updatedAt:
      typeof updatedAt === "string" && Number.isFinite(Date.parse(updatedAt))
        ? updatedAt.slice(0, 64)
        : null,
  };
}

/**
 * The shape `attachSession` is reached through.
 *
 * `ClientContext.attachSession` is declared `private` in the SDK's `.d.ts` but is
 * an ordinary prototype method in the emitted JavaScript, so it is callable. It
 * is the only thing that gives a session a per-session update queue, and
 * `SessionBuilder.start()` — the sole caller — only ever creates a brand new
 * session. Reached once, here, rather than at each call site.
 */
type AttachableContext = {
  attachSession(response: { sessionId: string }): ActiveSession;
};

function isAttachable(context: unknown): context is AttachableContext {
  return (
    typeof (context as Partial<AttachableContext>).attachSession === "function"
  );
}

/**
 * Attaches an update queue for an existing session id.
 *
 * Returns null when the installed SDK no longer exposes the method, so the
 * caller can refuse with a typed reason instead of continuing with a session
 * whose notifications would be dropped on the floor.
 */
export function attachSessionShim(
  context: ClientContext,
  sessionId: string,
): ActiveSession | null {
  if (!isAttachable(context)) return null;
  return (context as AttachableContext).attachSession({ sessionId });
}
