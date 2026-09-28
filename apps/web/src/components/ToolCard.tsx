import type { ComponentType } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  SparkIcon,
} from "@/components/icons";
import { cn } from "@/utils/cn";
import type { ToolCard as ToolCardState } from "@k5-work/shared";

/**
 * What the card can honestly say about one call.
 *
 * `lifecycle` is k5's own verdict on whether the call can still finish, so it
 * outranks the harness status. A card the reducer flipped to `cancelled` when
 * `turn.completed` arrived must not read as running again just because the
 * harness last said `in_progress`.
 */
type CardState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

const STATE_LABEL: Record<CardState, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  // The harness's word is "orphaned": the seat went away with the call still in
  // flight, so it never got to finish and never reported why.
  interrupted: "Interrupted",
};

const STATE_ICON: Record<CardState, ComponentType<{ className?: string }>> = {
  queued: ClockIcon,
  running: SparkIcon,
  completed: CheckIcon,
  failed: CloseIcon,
  cancelled: ArrowLeftIcon,
  interrupted: ClockIcon,
};

// The white-alpha ramp the Composer chips use, and nothing else: green and red
// mean diff counts in this app, so a failed call is stated in words instead.
const STATE_TINT: Record<CardState, string> = {
  queued: "text-white/35",
  running: "text-white/75",
  completed: "text-white/50",
  failed: "text-white/70",
  cancelled: "text-white/40",
  interrupted: "text-white/30",
};

function cardState(card: ToolCardState): CardState {
  if (card.lifecycle === "cancelled") return "cancelled";
  if (card.lifecycle === "orphaned") return "interrupted";
  switch (card.status) {
    case "pending":
      return "queued";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

/** The contract permits an empty title, and a nameless row says nothing. */
const UNTITLED = "Untitled tool call";

/**
 * One tool call, as a single settled row.
 *
 * No output pane and no collapsible body: the contract carries a title, a status
 * and a lifecycle, so anything more would be invented.
 */
export function ToolCard({ card }: { card: ToolCardState }) {
  const state = cardState(card);
  const Glyph = STATE_ICON[state];
  const label = STATE_LABEL[state];
  const title = card.title.trim() || UNTITLED;
  const working = state === "queued" || state === "running";

  return (
    <li
      role="listitem"
      aria-label={`${title}: ${label}`}
      aria-busy={working || undefined}
      data-state={state}
      className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5"
    >
      <Glyph className={cn("h-3.5 w-3.5 shrink-0", STATE_TINT[state])} />
      {/* Truncation is CSS only, so the whole title stays in the DOM and in the
          accessible name however long the harness makes it. */}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-white/75" title={title}>
        {title}
      </span>
      <span className="shrink-0 text-[11px] text-white/35">{label}</span>
    </li>
  );
}
