import type { ActiveSession, ClientContext } from "@agentclientprotocol/sdk";

// The one piece of ACP that the SDK does not hand a client, isolated here so
// the seat has one place that reaches past the public API and one place to argue
// about it.

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
