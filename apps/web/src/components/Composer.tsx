import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { Menu, type MenuItem } from "@/components/Menu";
import {
  ArrowUpIcon,
  CloseIcon,
  CubeIcon,
  FolderIcon,
  PaperclipIcon,
  ShieldCheckIcon,
  SparkIcon,
} from "@/components/icons";
import { cn } from "@/utils/cn";
import type { ConfigOptionSummary, Project } from "@k5-work/shared";
import {
  findConfigOption,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from "@k5-work/shared";

// Models and modes are NOT hardcoded. The harness advertises what the current
// machine can actually reach, which is the only list that can be honest: a
// static list of paid vendor models would offer choices that fail for anyone
// without those credentials. See docs/posture-and-trust-decisions.md.
const MODELS_DISCOVERY_HINT = "Discovering models…";
const MODELS_EMPTY_HINT = "No models available from this harness";

// Only `full` is offered. OpenCode resolves a blanket `*: allow` as the first
// rule, and the posture check refuses a wildcard for `read` and `review` before
// it reads any other rule, so a narrower pill would promise something k5 cannot
// enforce. See docs/posture-and-trust-decisions.md.
const PERMISSION_MODES: MenuItem[] = [
  { id: "full", label: "Full access", meta: "Read, edit, and run project commands" },
];

const OPEN_PROJECT_ID = "open-project";

// One card, one highlight. The drop affordance reuses the focus ring verbatim so
// enabling drops cannot become a second colour system.
const CARD_FOCUS_RING =
  "border-white/[0.13] shadow-[0_34px_90px_-26px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,190,150,0.09),inset_0_1px_0_rgba(255,255,255,0.07)]";

export type ComposerSettings = {
  /** A harness-advertised model value id. Empty until discovery returns. */
  model: string;
  /** A harness-advertised session mode id (build/plan). */
  mode: string;
  permissions: string;
};

export type PromptAttachment = {
  name: string;
  size: number;
  type: string;
};

export type PromptSubmission = {
  text: string;
  attachments: File[];
  settings: ComposerSettings;
  projectId?: string;
};

/**
 * A refused submission handed back down.
 *
 * Only needed for the one refusal the composer cannot be told about inline: on
 * the lazy-open path `onSend` has already returned by the time the answer
 * arrives, so the files have to travel back to the only place that can render
 * them. The id is monotonic so the same files can be returned twice and land
 * twice, and so a fresh mount does not replay a stale one.
 */
export type RestoredSubmission = {
  readonly id: number;
  readonly text: string;
  readonly attachments: readonly File[];
};

type ComposerProps = {
  activeProject?: Project;
  projects: Project[];
  settings: ComposerSettings;
  /** Harness-advertised config options; null before a session is open. */
  configOptions: ConfigOptionSummary[] | null;
  compact?: boolean;
  /** The last submission the parent could not deliver, or null. */
  restore?: RestoredSubmission | null;
  onRequestProject: () => void;
  onSelectProject: (id: string) => void;
  onSettingsChange: (settings: ComposerSettings) => void;
  /**
   * Hands the submission up and resolves true only once it was really sent or
   * really held for sending. False means nothing took it, and the composer keeps
   * the text and the files.
   */
  onSend: (submission: PromptSubmission) => Promise<boolean>;
};

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

/** Appends what is not already there, so a returned file never doubles up. */
function mergeFiles(current: readonly File[], incoming: readonly File[]): File[] {
  const present = new Set(current.map(fileKey));
  return [...current, ...incoming.filter((file) => !present.has(fileKey(file)))];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function Composer({
  activeProject,
  projects,
  settings,
  configOptions,
  compact = false,
  restore = null,
  onRequestProject,
  onSelectProject,
  onSettingsChange,
  onSend,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire again for every child the pointer crosses, so a
  // depth is what tells "left the card" from "moved onto a chip".
  const dragDepth = useRef(0);
  const restoredId = useRef<number | null>(null);
  // A send is now async, so a second press would upload the same bytes twice
  // before the first has reported back. A ref, not state: nothing about the
  // button's appearance may change.
  const sending = useRef(false);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [value]);

  useEffect(() => {
    if (!restore || restore.id === restoredId.current) return;
    restoredId.current = restore.id;
    setAttachments((current) => mergeFiles(current, restore.attachments));
    // Whatever the user has typed since is newer than the text being returned.
    setValue((current) => (current.length === 0 ? restore.text : current));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restore]);

  const addFiles = (incoming: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    // Deduplicated before the room is spent: a file that is already attached must
    // not occupy a slot and push a genuinely new one out.
    const present = new Set(attachments.map(fileKey));
    const notes: string[] = [];
    const oversized: string[] = [];
    const overRoom: string[] = [];
    const accepted: File[] = [];
    for (const file of incoming) {
      const key = fileKey(file);
      if (present.has(key)) continue;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        oversized.push(file.name);
      } else if (accepted.length >= room) {
        overRoom.push(file.name);
      } else {
        present.add(key);
        accepted.push(file);
      }
    }
    // Both refusals say what to do about them: a file the user cannot re-pick is
    // a file they cannot attach at all.
    if (oversized.length > 0) {
      notes.push(
        `${oversized.join(", ")} ${oversized.length === 1 ? "is" : "are"} larger than ${formatFileSize(
          MAX_ATTACHMENT_BYTES,
        )}.`,
      );
    }
    if (overRoom.length > 0) {
      notes.push(
        `${overRoom.join(", ")} ${overRoom.length === 1 ? "was" : "were"} not added: a prompt can carry ${String(
          MAX_ATTACHMENTS,
        )} attachments at most. Remove ${String(overRoom.length)} and add ${
          overRoom.length === 1 ? "it back" : "them back"
        }.`,
      );
    }
    setAttachmentError(notes.join(" "));
    setAttachments((current) => mergeFiles(current, accepted));
  };

  const submit = async () => {
    const text = value.trim();
    if (!text) return;
    if (sending.current) return;
    sending.current = true;
    let sent = false;
    try {
      sent = await onSend({
        text,
        attachments,
        settings,
        projectId: activeProject?.id,
      });
    } catch {
      // A parent that throws has delivered nothing either, so the files stay.
    } finally {
      sending.current = false;
    }
    // The chips are the only copy of these bytes before the upload. Clearing
    // them on a refusal is a one-way door: the file is gone from the composer
    // and the user cannot re-pick it from a directory they may not even have
    // open, so nothing clears until the parent says the submission went out.
    if (!sent) return;
    setValue("");
    setAttachments([]);
    setAttachmentError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = textareaRef.current;
    if (!element) return;
    const isMod = event.metaKey || event.ctrlKey;

    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key === "Enter" && event.shiftKey && !event.nativeEvent.isComposing) {
      const { selectionStart, selectionEnd } = element;
      const textBefore = value.slice(0, selectionStart);
      const textAfter = value.slice(selectionEnd);
      const lastLine = textBefore.split("\n").pop() ?? "";
      const bulletMatch = lastLine.match(/^(\s*)([-*+])\s+(.*)$/);
      if (bulletMatch) {
        event.preventDefault();
        const [, indent, bullet, content] = bulletMatch;
        if (!content.trim()) {
          const lineStart = selectionStart - lastLine.length;
          setValue(value.slice(0, lineStart) + textAfter);
          requestAnimationFrame(() => {
            element.selectionStart = element.selectionEnd = lineStart;
          });
          return;
        }
        const insert = `\n${indent}${bullet} `;
        setValue(textBefore + insert + textAfter);
        requestAnimationFrame(() => {
          element.selectionStart = element.selectionEnd = selectionStart + insert.length;
        });
        return;
      }

      const numberMatch = lastLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (numberMatch) {
        event.preventDefault();
        const [, indent, number, content] = numberMatch;
        if (!content.trim()) {
          const lineStart = selectionStart - lastLine.length;
          setValue(value.slice(0, lineStart) + textAfter);
          requestAnimationFrame(() => {
            element.selectionStart = element.selectionEnd = lineStart;
          });
          return;
        }
        const nextNumber = Number.parseInt(number, 10) + 1;
        const insert = `\n${indent}${nextNumber}. `;
        setValue(textBefore + insert + textAfter);
        requestAnimationFrame(() => {
          element.selectionStart = element.selectionEnd = selectionStart + insert.length;
        });
        return;
      }
    }

    if (event.key === "Tab" && !isMod) {
      const { selectionStart, selectionEnd } = element;
      const textBefore = value.slice(0, selectionStart);
      const textAfter = value.slice(selectionEnd);
      const lastLine = textBefore.split("\n").pop() ?? "";
      const isList =
        lastLine.trim().startsWith("-") ||
        lastLine.trim().startsWith("*") ||
        /^\d+\./.test(lastLine.trim());
      if (isList) {
        event.preventDefault();
        if (event.shiftKey && lastLine.startsWith("  ")) {
          const lineStart = selectionStart - lastLine.length;
          setValue(value.slice(0, lineStart) + lastLine.slice(2) + textAfter);
          requestAnimationFrame(() => {
            element.selectionStart = element.selectionEnd = Math.max(lineStart, selectionStart - 2);
          });
        } else if (!event.shiftKey) {
          const lineStart = selectionStart - lastLine.length;
          setValue(value.slice(0, lineStart) + "  " + lastLine + textAfter);
          requestAnimationFrame(() => {
            element.selectionStart = element.selectionEnd = selectionStart + 2;
          });
        }
        return;
      }
    }

    if (isMod && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "i" || key === "k" || key === "e") {
        event.preventDefault();
        const { selectionStart, selectionEnd } = element;
        const selected = value.slice(selectionStart, selectionEnd);
        const textBefore = value.slice(0, selectionStart);
        const textAfter = value.slice(selectionEnd);
        let insert = "";
        let cursorStart = selectionStart;
        let cursorEnd = selectionEnd;
        if (key === "i") {
          insert = `*${selected}*`;
          cursorStart = selected ? selectionStart : selectionStart + 1;
          cursorEnd = selected ? selectionStart + insert.length : selectionStart + 1;
        } else if (key === "k") {
          insert = `[${selected || "text"}](url)`;
          cursorStart = selected ? selectionStart + insert.indexOf("(url)") + 1 : selectionStart + 1;
          cursorEnd = selected ? cursorStart + 3 : selectionStart + 5;
        } else {
          const multiline = selected.includes("\n");
          insert = multiline ? `\`\`\`\n${selected}\n\`\`\`` : `\`${selected}\``;
          cursorStart = selected ? selectionStart : selectionStart + (multiline ? 4 : 1);
          cursorEnd = selected ? selectionStart + insert.length : cursorStart;
        }
        setValue(textBefore + insert + textAfter);
        requestAnimationFrame(() => {
          element.selectionStart = cursorStart;
          element.selectionEnd = cursorEnd;
        });
      }
    }
  };

  // Discovered by the harness at session open. `null` means the session is not
  // open yet, which is different from "open with nothing to offer".
  const modelsOption = configOptions === null ? null : findConfigOption(configOptions, "model");
  const modeOption = configOptions === null ? null : findConfigOption(configOptions, "mode");
  // A boolean option carries no value list, so it is reported as unusable rather
  // than rendered as a menu that can never open.
  const toMenuItems = (option: ConfigOptionSummary | null): MenuItem[] | null => {
    if (!option || option.type !== "select") return null;
    return option.values.map((v) => ({ id: v.value, label: v.label }));
  };
  const models = toMenuItems(modelsOption);
  const modes = toMenuItems(modeOption);
  // The harness's `current` is authoritative once a session is open: it is what
  // the seat is actually running. The composer's value is a pending intent, so
  // it is only used when the harness has not reported a current value yet.
  // Falling back to the first entry would be a guess.
  const activeModel =
    models?.find((item) => item.id === (modelsOption?.current ?? settings.model)) ??
    models?.find((item) => item.id === settings.model);
  const activeMode =
    modes?.find((item) => item.id === (modeOption?.current ?? settings.mode)) ??
    modes?.find((item) => item.id === settings.mode);
  const activePermissions = PERMISSION_MODES.find((item) => item.id === settings.permissions);
  const projectItems: MenuItem[] = [
    {
      id: OPEN_PROJECT_ID,
      label: "Open another folder…",
      meta: "Enter a path on this computer",
      icon: <FolderIcon className="h-4 w-4" />,
      role: "menuitem",
    },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      meta: project.meta ?? project.path,
      icon: <FolderIcon className="h-4 w-4" />,
    })),
  ];
  const canSend = value.trim().length > 0;

  return (
    <div className="w-full">
      {!compact ? (
        <div className="animate-fade-up mb-5 px-2 text-center" style={{ animationDelay: "80ms" }}>
          <h2 className="text-balance font-serif text-[clamp(28px,4vw,44px)] font-normal leading-[1.08] tracking-[-0.025em] text-white/90">
            What should we build in {activeProject?.name ?? "your project"}?
          </h2>
        </div>
      ) : null}

      <div className="animate-fade-up mb-2 flex justify-center px-1" style={{ animationDelay: "120ms" }}>
        <Menu
          ariaLabel={`Project folder. Current: ${activeProject?.name ?? "none"}`}
          items={projectItems}
          value={activeProject?.id}
          onSelect={(id) => {
            if (id === OPEN_PROJECT_ID) onRequestProject();
            else onSelectProject(id);
          }}
          direction="up"
          className="flex max-w-[min(32rem,90vw)] items-center gap-2 rounded-full px-2.5 py-1.5 text-[13.5px] font-medium text-white/65 transition-colors duration-200 hover:bg-white/[0.07] hover:text-white"
          panelClassName="w-[min(22rem,calc(100vw-2rem))] min-w-0"
        >
          <FolderIcon className="h-4 w-4 shrink-0 opacity-80" />
          <span className="truncate">{activeProject?.name ?? "Choose a project"}</span>
        </Menu>
      </div>

      <div
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          event.dataTransfer.dropEffect = "copy";
          setDropTarget(true);
        }}
        onDragOver={(event) => {
          // Without a preventDefault the browser navigates to the file instead of
          // handing it over, so the default has to be refused on every dragover.
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropTarget(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDropTarget(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "glass-card animate-fade-up rounded-[28px] transition-[box-shadow,border-color,transform] duration-300 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] hover:border-white/[0.12]",
          focused || dropTarget ? CARD_FOCUS_RING : null,
        )}
        style={{ animationDelay: "120ms" }}
      >
        {attachments.length > 0 ? (
          <ul className="flex flex-wrap gap-2 px-5 pt-4">
            {attachments.map((file) => {
              const key = fileKey(file);
              return (
                <li key={key}>
                  <span
                    className="group/file flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] py-1.5 pl-2.5 pr-1.5 text-[12.5px] text-white/75 transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.1]"
                    title={`${file.name}, ${formatFileSize(file.size)}`}
                  >
                    <PaperclipIcon className="h-3.5 w-3.5 text-white/45" />
                    <span className="max-w-12rem truncate">{file.name}</span>
                    <span className="text-[11px] text-white/35">{formatFileSize(file.size)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setAttachments((current) => current.filter((item) => fileKey(item) !== key))}
                      className="grid h-5 w-5 cursor-pointer place-items-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white"
                    >
                      <CloseIcon className="h-3 w-3" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        {attachmentError ? (
          <p role="alert" className="px-5 pt-3 text-[12px] text-white/65">
            {attachmentError}
          </p>
        ) : null}

        <label className="sr-only" htmlFor="composer-input">
          Describe what the agent should work on
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          rows={1}
          value={value}
          placeholder="Describe the change the agent should make…"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            "thin-scroll block max-h-[220px] w-full resize-none bg-transparent font-serif font-normal leading-[1.34] tracking-[-0.013em] text-white/95 [caret-color:#ffb98a] placeholder:text-white/[0.38] focus:outline-none",
            compact ? "px-5 pb-1.5 pt-[14px] text-[clamp(15px,1.7vw,18px)]" : "px-6 pb-2 pt-[22px] text-[clamp(17px,2vw,22px)]",
          )}
        />

        <div className={cn("flex items-end gap-1.5", compact ? "px-3 pb-2.5 pt-1" : "px-3.5 pb-3 pt-1.5")}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label="Files to attach"
            onChange={handleFileChange}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "grid shrink-0 place-items-center rounded-full text-white/60 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white",
              compact ? "h-8 w-8" : "h-9 w-9",
            )}
          >
            <PaperclipIcon className={compact ? "h-[17px] w-[17px]" : "h-[19px] w-[19px]"} />
          </button>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
            {/* Models come from the harness. Until a session is open the menu
                says so rather than showing a hardcoded vendor list that may
                not be reachable on this machine. */}
            <Menu
              ariaLabel={`Model. Current: ${activeModel?.label ?? "not discovered yet"}`}
              items={models ?? [{ id: "", label: configOptions === null ? MODELS_DISCOVERY_HINT : MODELS_EMPTY_HINT }]}
              value={settings.model}
              onSelect={(model) => onSettingsChange({ ...settings, model })}
              disabled={models === null || models.length === 0}
              direction="up"
              className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1.5 text-[12.5px] font-medium text-white/70 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white"
            >
              <CubeIcon className="h-4 w-4 shrink-0 text-white/70" />
              <span className="max-w-24 truncate">
                {activeModel?.label ??
                  (configOptions === null ? "Discovering…" : "No models")}
              </span>
            </Menu>
            {/* The harness calls this a session mode (build/plan), not a
                thinking level. Labelling it as a thinking level would claim a
                capability the harness does not have. */}
            <Menu
              ariaLabel={`Session mode. Current: ${activeMode?.label ?? "not discovered yet"}`}
              items={modes ?? [{ id: "", label: MODELS_DISCOVERY_HINT }]}
              value={settings.mode}
              onSelect={(mode) => onSettingsChange({ ...settings, mode })}
              disabled={modes === null || modes.length === 0}
              direction="up"
              className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[12.5px] font-medium text-white/65 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white"
            >
              <SparkIcon className="h-3.5 w-3.5 shrink-0 text-white/60" />
              <span>
                {activeMode?.label ?? (configOptions === null ? "Mode" : "No modes")}
              </span>
            </Menu>
            <Menu
              ariaLabel={`Permissions. Current: ${activePermissions?.label ?? "unknown"}`}
              items={PERMISSION_MODES}
              value={settings.permissions}
              onSelect={(permissions) => onSettingsChange({ ...settings, permissions })}
              direction="up"
              align="right"
              className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[12.5px] font-medium text-white/65 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white"
            >
              <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 text-white/60" />
              <span className="max-w-28 truncate">{activePermissions?.label ?? "Review changes"}</span>
            </Menu>
          </div>

          <button
            type="button"
            aria-label="Send message"
            aria-keyshortcuts="Enter"
            title="Send"
            disabled={!canSend}
            onClick={submit}
            className={cn(
              "flex shrink-0 items-center justify-center gap-1.5 rounded-[14px] font-semibold transition duration-200 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)]",
              "bg-white text-[#141414] shadow-[0_8px_22px_-10px_rgba(255,255,255,0.55)]",
              "hover:bg-white/90 hover:shadow-[0_12px_30px_-10px_rgba(255,255,255,0.6)] active:scale-[0.97]",
              "disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30 disabled:shadow-none",
              compact ? "h-9 px-3 text-[12.5px]" : "h-10 px-3.5 text-[13px]",
            )}
          >
            <span>Send</span>
            <ArrowUpIcon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </button>
        </div>
      </div>
    </div>
  );
}
