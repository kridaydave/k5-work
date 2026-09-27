import { ShieldCheckIcon } from "@/components/icons";
import { cn } from "@/utils/cn";
import type { PendingPermission } from "@k5-work/shared";

export interface PermissionPromptProps {
  request: PendingPermission;
  onDecide: (optionId: string | null) => void;
}

/**
 * Asks the user to authorise one tool call.
 *
 * This is a required state, not an extra: a harness blocks on
 * `session/request_permission` until it is answered, so without a visible
 * prompt the turn would hang with nothing on screen. Every request is
 * answerable, including refusing, because a prompt with no way out is a dead
 * end.
 */
export function PermissionPrompt({ request, onDecide }: PermissionPromptProps) {
  return (
    <div
      role="group"
      aria-label={`Permission needed: ${request.title}`}
      className="animate-fade-up mx-auto w-full max-w-[800px] rounded-2xl border border-white/12 bg-white/[0.05] px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-white/50" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">
            Permission needed
          </p>
          <p className="mt-1 text-[14px] leading-relaxed text-white/90">{request.title}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {request.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            // A rejection is as valid a choice as an approval, so it is offered
            // as a first-class button rather than a dismiss click.
            className={cn(
              "rounded-lg border px-3 py-1.5 text-[13px] transition-colors",
              option.kind === "reject_once" || option.kind === "reject_always"
                ? "border-white/15 text-white/70 hover:bg-white/10"
                : "border-white/25 text-white hover:bg-white/10",
            )}
            onClick={() => onDecide(option.optionId)}
          >
            {option.name}
          </button>
        ))}
        <button
          type="button"
          className="rounded-lg border border-white/15 px-3 py-1.5 text-[13px] text-white/70 transition-colors hover:bg-white/10"
          onClick={() => onDecide(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
