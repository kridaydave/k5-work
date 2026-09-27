import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ToolLifecycle, ToolStatus } from "@k5-work/shared";

// ACP 1.5.0 has more SessionUpdate variants than the short documentation table,
// so the classification is derived from the pinned generated union rather than
// from prose. Every variant is rendered, safely ignored, or suppressed, and the
// exhaustive check at the bottom fails the build if a new one is added without
// a decision.

export type UpdateVerdict =
  | { kind: "text"; stream: "text" | "thought"; text: string }
  | { kind: "tool"; toolCallId: string; title: string; status: ToolStatus }
  | { kind: "ignore"; reason: string }
  | { kind: "suppress"; reason: string };

type VariantName = SessionUpdate["sessionUpdate"];

// Keyed by the pinned union, so a new SDK variant is a *compile* error here
// until it is given a verdict. A hand-kept array would silently accept a
// subset and the claim of exhaustiveness would be false.
const IGNORED = {
  usage_update: "usage meters are not rendered in the first slice",
  config_option_update: "config options are only read at session.opened",
  current_mode_update: "modes are not surfaced in the first slice",
  session_info_update: "session metadata is not rendered in the first slice",
  available_commands_update: "command inventory is bounded, not forwarded",
  plan: "plan rendering is not implemented",
} satisfies Record<string, string>;

// These are capability-gated. k5 does not advertise `notices`, `compaction`, or
// the unstable `plan` capability, so receiving one means the agent sent it
// anyway: suppress and log rather than trusting the SDK to filter it.
const SUPPRESSED = {
  notice: "k5 does not advertise the notices capability",
  compaction_update: "k5 does not advertise the compaction capability",
  compaction_summary_chunk: "k5 does not advertise the compaction capability",
  plan_update: "k5 does not advertise the unstable plan capability",
  plan_removed: "k5 does not advertise the unstable plan capability",
} satisfies Record<string, string>;

// Asserted to cover exactly the pinned union, so a variant cannot be added to
// the SDK without a decision here.
type Unclassified = Exclude<VariantName, keyof typeof IGNORED | keyof typeof SUPPRESSED
  | "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk"
  | "tool_call" | "tool_call_update">;
const EXHAUSTIVE: Unclassified extends never ? true : never = true;
void EXHAUSTIVE;

function toToolStatus(raw: string | undefined): ToolStatus {
  switch (raw) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "in_progress":
      return "in_progress";
    default:
      return "pending";
  }
}

export function classifySessionUpdate(update: SessionUpdate): UpdateVerdict {
  const variant = update.sessionUpdate as string;

  if (variant === "agent_message_chunk" || variant === "user_message_chunk") {
    const content = (update as { content?: { type?: string; text?: string } }).content;
    if (!content || content.type !== "text" || typeof content.text !== "string") {
      // Image/audio/resource chunks need a client capability k5 has not
      // advertised, so they are suppressed rather than rendered as text.
      return { kind: "suppress", reason: `non-text ${variant}` };
    }
    return { kind: "text", stream: "text", text: content.text };
  }

  if (variant === "agent_thought_chunk") {
    const content = (update as { content?: { type?: string; text?: string } }).content;
    if (!content || content.type !== "text" || typeof content.text !== "string") {
      return { kind: "suppress", reason: "non-text thought chunk" };
    }
    return { kind: "text", stream: "thought", text: content.text };
  }

  if (variant === "tool_call" || variant === "tool_call_update") {
    const payload = update as {
      toolCallId?: string;
      title?: string;
      status?: string;
    };
    if (typeof payload.toolCallId !== "string" || payload.toolCallId.length === 0) {
      return { kind: "suppress", reason: "tool update without a toolCallId" };
    }
    return {
      kind: "tool",
      toolCallId: payload.toolCallId,
      title: typeof payload.title === "string" ? payload.title : "",
      status: toToolStatus(payload.status),
    };
  }

  const suppressed = (SUPPRESSED as Record<string, string>)[variant];
  if (suppressed !== undefined) {
    return { kind: "suppress", reason: suppressed };
  }
  const ignored = (IGNORED as Record<string, string>)[variant];
  if (ignored !== undefined) {
    return { kind: "ignore", reason: ignored };
  }
  return { kind: "suppress", reason: `unclassified variant ${variant}` };
}

// The tool status ACP reported is preserved on cancel; only the k5-local
// lifecycle changes, so a cancelled card is never left looking in-progress.
export function lifecycleForStop(
  stopReason: "cancelled" | "k5-timeout" | "k5-error" | "k5-cancelled",
): ToolLifecycle {
  return stopReason === "k5-error" ? "orphaned" : "cancelled";
}

