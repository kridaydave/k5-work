import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
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
import type { Project } from "@k5-work/shared";

const MODELS: MenuItem[] = [
  { id: "opus", label: "Claude Opus 4.5", meta: "Deepest reasoning · slowest" },
  { id: "sonnet", label: "Claude Sonnet 4.5", meta: "Best for everyday work" },
  { id: "haiku", label: "Claude Haiku 4.5", meta: "Fastest responses" },
];

const THINKING_LEVELS: MenuItem[] = [
  { id: "low", label: "Low", meta: "Quick edits and simple questions" },
  { id: "medium", label: "Medium", meta: "Balanced depth and speed" },
  { id: "high", label: "High", meta: "Deeper planning for complex work" },
];

const PERMISSION_MODES: MenuItem[] = [
  { id: "full", label: "Full access", meta: "Read, edit, and run project commands" },
  { id: "review", label: "Review changes", meta: "Pause before applying edits" },
  { id: "read", label: "Read only", meta: "Inspect files without changing them" },
];

const OPEN_PROJECT_ID = "open-project";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type ComposerSettings = {
  model: string;
  thinking: string;
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

type ComposerProps = {
  activeProject?: Project;
  projects: Project[];
  settings: ComposerSettings;
  compact?: boolean;
  onRequestProject: () => void;
  onSelectProject: (id: string) => void;
  onSettingsChange: (settings: ComposerSettings) => void;
  onSend: (submission: PromptSubmission) => void;
};

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
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
  compact = false,
  onRequestProject,
  onSelectProject,
  onSettingsChange,
  onSend,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [value]);

  const addFiles = (incoming: File[]) => {
    const rejected: string[] = [];
    const accepted = incoming.filter((file) => {
      if (file.size <= MAX_ATTACHMENT_BYTES) return true;
      rejected.push(file.name);
      return false;
    });
    setAttachmentError(
      rejected.length > 0
        ? `${rejected.join(", ")} ${rejected.length === 1 ? "is" : "are"} larger than 25 MB.`
        : "",
    );
    setAttachments((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...accepted.filter((file) => !existing.has(fileKey(file)))];
    });
  };

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSend({
      text,
      attachments,
      settings,
      projectId: activeProject?.id,
    });
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

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
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

  const activeModel = MODELS.find((item) => item.id === settings.model);
  const activeThinking = THINKING_LEVELS.find((item) => item.id === settings.thinking);
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
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "glass-card animate-fade-up rounded-[28px] transition-[box-shadow,border-color,transform] duration-300 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] hover:border-white/[0.12]",
          focused
            ? "border-white/[0.13] shadow-[0_34px_90px_-26px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,190,150,0.09),inset_0_1px_0_rgba(255,255,255,0.07)]"
            : null,
          dragging && "border-white/30 shadow-[0_34px_90px_-26px_rgba(0,0,0,0.9)]",
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
          placeholder={dragging ? "Drop files to attach" : "Describe the change or attach a file…"}
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
            onChange={handleFileChange}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "grid shrink-0 cursor-pointer place-items-center rounded-full text-white/55 transition duration-200 hover:bg-white/[0.09] hover:text-white active:scale-95",
              compact ? "h-8 w-8" : "h-9 w-9",
            )}
          >
            <PaperclipIcon className={compact ? "h-[17px] w-[17px]" : "h-[19px] w-[19px]"} />
          </button>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
            <Menu
              ariaLabel={`Model. Current: ${activeModel?.label ?? "unknown"}`}
              items={MODELS}
              value={settings.model}
              onSelect={(model) => onSettingsChange({ ...settings, model })}
              direction="up"
              className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1.5 text-[12.5px] font-medium text-white/70 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white"
            >
              <CubeIcon className="h-4 w-4 shrink-0 text-white/70" />
              <span className="max-w-24 truncate">{activeModel?.label.replace("Claude ", "") ?? "Model"}</span>
            </Menu>
            <Menu
              ariaLabel={`Thinking level. Current: ${activeThinking?.label ?? "unknown"}`}
              items={THINKING_LEVELS}
              value={settings.thinking}
              onSelect={(thinking) => onSettingsChange({ ...settings, thinking })}
              direction="up"
              className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[12.5px] font-medium text-white/65 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white"
            >
              <SparkIcon className="h-3.5 w-3.5 shrink-0 text-white/60" />
              <span>{activeThinking?.label ?? "Medium"}</span>
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
