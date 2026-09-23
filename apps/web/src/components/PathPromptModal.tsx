import { useEffect, useRef, useState } from "react";
import { CloseIcon, FolderIcon } from "@/components/icons";

type PathPromptModalProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (path: string) => Promise<void>;
};

export function PathPromptModal({ open, onClose, onSubmit }: PathPromptModalProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setValue("");
    setError("");
    setSubmitting(false);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      requestAnimationFrame(() => previousFocusRef.current?.focus());
    };
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!open) return;
      if (event.key === "Escape" && !submitting) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const path = value.trim();
    if (!path || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(path);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The folder could not be opened");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="path-dialog-title"
      aria-describedby="path-dialog-description"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[4px] animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div ref={dialogRef} className="w-full max-w-md rounded-[22px] border border-white/[0.12] bg-[#0b0b0c] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.85)] animate-fade-up">
        <div className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <FolderIcon className="h-4 w-4 text-white/70" />
            <h2 id="path-dialog-title" className="text-[15px] font-semibold text-white/95">
              Open project folder
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close dialog"
            disabled={submitting}
            onClick={onClose}
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-full text-white/45 transition hover:bg-white/[0.09] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <p id="path-dialog-description" className="pb-3 text-[12.5px] leading-relaxed text-white/45">
          Enter an absolute path or a home-relative path such as{" "}
          <code className="rounded bg-white/10 px-1 py-0.5 text-white/75">~/code/explore</code>.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="rounded-xl border border-white/[0.1] bg-black/50 px-3 py-2 transition-colors focus-within:border-white/30">
            <input
              ref={inputRef}
              type="text"
              placeholder="/path/to/project"
              value={value}
              disabled={submitting}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "path-dialog-error" : undefined}
              onChange={(event) => setValue(event.target.value)}
              className="w-full bg-transparent font-mono text-[13px] text-white/90 placeholder:text-white/25 focus:outline-none disabled:opacity-50"
            />
          </div>

          {error ? (
            <p id="path-dialog-error" role="alert" className="text-[12px] text-white/60">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="cursor-pointer rounded-xl px-3.5 py-1.5 text-[13px] font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!value.trim() || submitting}
              className="cursor-pointer rounded-xl bg-white px-4 py-1.5 text-[13px] font-medium text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {submitting ? "Opening…" : "Open folder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
