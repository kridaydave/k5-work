import { useEffect, useRef, useState } from "react";
import { Menu, type MenuItem } from "@/components/Menu";
import {
  CloseIcon,
  CubeIcon,
  FolderIcon,
  PaperclipIcon,
  ArrowUpIcon,
  SparkIcon,
} from "@/components/icons";
import { cn } from "@/utils/cn";

const MODELS: MenuItem[] = [
  { id: "opus", label: "Claude Opus 4.5", meta: "Deepest reasoning · slowest" },
  { id: "sonnet", label: "Claude Sonnet 4.5", meta: "Best for everyday work" },
  { id: "haiku", label: "Claude Haiku 4.5", meta: "Fastest responses" },
];

const CONTEXTS: MenuItem[] = [
  { id: "context", label: "context", meta: "12 files · 48K tokens", icon: <FolderIcon className="h-4 w-4" /> },
  { id: "design", label: "design-system", meta: "6 files · 21K tokens", icon: <FolderIcon className="h-4 w-4" /> },
  { id: "none", label: "No context", meta: "Start from a blank slate", icon: <SparkIcon className="h-4 w-4" /> },
];

const DIRECTORIES: MenuItem[] = [
  { id: "current", label: "Current checkout", meta: "~/dev/cowork · branch main" },
  { id: "another", label: "Choose another folder…" },
];

const SAMPLE_FILES = ["screenshot-2026-04-12.png", "quarterly-metrics.csv", "onboarding-flow.fig", "api-spec.yaml"];

type ComposerProps = {
  onSend: (text: string) => void;
};

export function Composer({ onSend }: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [model, setModel] = useState("sonnet");
  const [context, setContext] = useState("context");
  const [directory, setDirectory] = useState("current");
  const [attachments, setAttachments] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileCursor = useRef(0);

  // auto-grow the textarea as the user types
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const attachFile = () => {
    const next = SAMPLE_FILES[fileCursor.current % SAMPLE_FILES.length];
    fileCursor.current += 1;
    setAttachments((prev) => (prev.includes(next) ? prev : [...prev, next]));
    textareaRef.current?.focus();
  };

  const submit = () => {
    if (!value.trim()) return;
    onSend(value.trim());
    setValue("");
    setAttachments([]);
  };

  const activeModel = MODELS.find((m) => m.id === model);
  const activeContext = CONTEXTS.find((c) => c.id === context);

  return (
    <div className="w-full">
      {/* context picker, floating above the card */}
      <div className="animate-fade-up mb-2 px-1.5" style={{ animationDelay: "120ms" }}>
        <Menu
          ariaLabel="Choose context"
          items={CONTEXTS}
          value={context}
          onSelect={setContext}
          direction="down"
          className="flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-2 text-[14.5px] font-medium text-white/65 transition-colors duration-200 hover:bg-white/[0.07] hover:text-white"
        >
          <FolderIcon className="h-[17px] w-[17px] opacity-80" />
          <span className="max-w-[42vw] truncate">{activeContext?.label ?? "context"}</span>
        </Menu>
      </div>

      {/* the composer card */}
      <div
        className={cn(
          "glass-card animate-fade-up rounded-[28px] transition-[box-shadow,border-color,transform] duration-500 hover:border-white/[0.12]",
          focused
            ? "border-white/[0.13] shadow-[0_34px_90px_-26px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,190,150,0.09),inset_0_1px_0_rgba(255,255,255,0.07)]"
            : null,
        )}
        style={{ animationDelay: "200ms" }}
      >
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-5 pt-4">
            {attachments.map((file) => (
              <li key={file}>
                <span className="group/file flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] py-1.5 pl-2.5 pr-1.5 text-[12.5px] text-white/75 transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.1]">
                  <PaperclipIcon className="h-3.5 w-3.5 text-white/45" />
                  <span className="max-w-[16rem] truncate">{file}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file}`}
                    onClick={() => setAttachments((prev) => prev.filter((f) => f !== file))}
                    className="grid h-5 w-5 cursor-pointer place-items-center rounded-md text-white/45 transition hover:bg-white/10 hover:text-white"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <label className="sr-only" htmlFor="composer-input">
          Ask Claude to do anything
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          rows={1}
          value={value}
          placeholder="Do anything…"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="thin-scroll block max-h-[220px] w-full resize-none bg-transparent px-6 pb-2 pt-[22px] font-serif text-[clamp(19px,2.35vw,26px)] font-normal leading-[1.34] tracking-[-0.013em] text-white/95 [caret-color:#ffb98a] placeholder:text-white/[0.38] focus:outline-none"
        />

        <div className="flex items-center gap-1.5 px-3.5 pb-3 pt-1.5">
          <button
            type="button"
            aria-label="Attach a file"
            title="Attach a file"
            onClick={attachFile}
            className="grid h-9 w-9 cursor-pointer place-items-center rounded-full text-white/55 transition duration-200 hover:bg-white/[0.09] hover:text-white active:scale-95"
          >
            <PaperclipIcon className="h-[19px] w-[19px]" />
          </button>

          <div className="flex-1" />

          <Menu
            ariaLabel="Choose model"
            items={MODELS}
            value={model}
            onSelect={setModel}
            direction="up"
            align="right"
            className="flex items-center gap-2 rounded-full py-1.5 pl-2 pr-1.5 text-[14.5px] font-medium text-white/85 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white"
          >
            <CubeIcon className="h-[18px] w-[18px] text-white/80" />
            <span>{activeModel?.label.split(" ").slice(0, 2).join(" ") ?? "Claude"}</span>
          </Menu>

          <button
            type="button"
            aria-label="Send message"
            title="Send"
            onClick={submit}
            className={cn(
              "ml-0.5 grid h-10 w-10 cursor-pointer place-items-center rounded-full transition duration-300",
              "bg-white text-[#141414] shadow-[0_8px_22px_-10px_rgba(255,255,255,0.55)]",
              "hover:scale-[1.07] hover:shadow-[0_12px_30px_-10px_rgba(255,255,255,0.6)] active:scale-95",
              !value.trim() && "shadow-none",
            )}
          >
            <ArrowUpIcon className="h-[19px] w-[19px]" />
          </button>
        </div>
      </div>

      {/* working directory row, under the card */}
      <div
        className="animate-fade-up mt-2.5 flex items-center justify-between gap-3 px-1.5"
        style={{ animationDelay: "280ms" }}
      >
        <Menu
          ariaLabel="Choose working folder"
          items={DIRECTORIES}
          value={directory}
          onSelect={setDirectory}
          direction="down"
          className="flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-2 text-[14.5px] font-medium text-white/65 transition-colors duration-200 hover:bg-white/[0.07] hover:text-white"
        >
          <FolderIcon className="h-[17px] w-[17px] opacity-80" />
          <span className="max-w-[52vw] truncate sm:max-w-none">
            {DIRECTORIES.find((d) => d.id === directory)?.label ?? "Current checkout"}
          </span>
        </Menu>

        <p className="hidden shrink-0 text-[12px] font-medium tracking-[0.01em] text-white/25 sm:block">
          <kbd className="font-sans">⇧</kbd>
          <span className="px-1">+</span>
          <kbd className="font-sans">⏎</kbd>
          <span className="pl-1.5">new line</span>
        </p>
      </div>
    </div>
  );
}
