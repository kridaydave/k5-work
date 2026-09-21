import { useEffect, useRef, useState } from "react";
import { Menu, type MenuItem } from "@/components/Menu";
import {
  BranchIcon,
  CloseIcon,
  CubeIcon,
  DisplayIcon,
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
  { id: "current", label: "Local checkout", meta: "~/dev/cowork · branch main" },
  { id: "another", label: "Choose another folder…" },
];

const BRANCHES: MenuItem[] = [
  { id: "main", label: "main", meta: "up to date with origin" },
  { id: "feat/composer", label: "feat/composer", meta: "2 ahead · 1 behind" },
  { id: "release/5.1", label: "release/5.1", meta: "protected" },
];

const DEVICES: MenuItem[] = [
  { id: "laptop", label: "Nairine", meta: "Connected · This device" },
  { id: "tablet", label: "Silvia", meta: "Available · Remote" },
  { id: "add", label: "Add a computer…" },
];

const SAMPLE_FILES = ["screenshot-2026-04-12.png", "quarterly-metrics.csv", "onboarding-flow.fig", "api-spec.yaml"];

type ComposerProps = {
  onSend: (text: string) => void;
  /** tighter paddings + smaller type for the bottom-docked thread state */
  compact?: boolean;
};

export function Composer({ onSend, compact = false }: ComposerProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [model, setModel] = useState("sonnet");
  const [context, setContext] = useState("context");
  const [directory, setDirectory] = useState("current");
  const [branch, setBranch] = useState("main");
  const [device, setDevice] = useState("laptop");
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
          direction="up"
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
          className={cn(
            "thin-scroll block max-h-[220px] w-full resize-none bg-transparent font-serif font-normal leading-[1.34] tracking-[-0.013em] text-white/95 [caret-color:#ffb98a] placeholder:text-white/[0.38] focus:outline-none",
            compact
              ? "px-5 pb-1.5 pt-[14px] text-[clamp(15px,1.7vw,18px)]"
              : "px-6 pb-2 pt-[22px] text-[clamp(17px,2vw,22px)]",
          )}
        />

        <div className={cn("flex items-center gap-1.5", compact ? "px-3 pb-2.5 pt-1" : "px-3.5 pb-3 pt-1.5")}>
          <button
            type="button"
            aria-label="Attach a file"
            title="Attach a file"
            onClick={attachFile}
            className={cn(
              "grid cursor-pointer place-items-center rounded-full text-white/55 transition duration-200 hover:bg-white/[0.09] hover:text-white active:scale-95",
              compact ? "h-8 w-8" : "h-9 w-9",
            )}
          >
            <PaperclipIcon className={compact ? "h-[17px] w-[17px]" : "h-[19px] w-[19px]"} />
          </button>

          <div className="flex-1" />

          <Menu
            ariaLabel="Choose model"
            items={MODELS}
            value={model}
            onSelect={setModel}
            direction="up"
            align="right"
            className={cn(
              "flex items-center gap-2 rounded-full py-1.5 pl-2 pr-1.5 font-medium text-white/85 transition-colors duration-200 hover:bg-white/[0.09] hover:text-white",
              compact ? "text-[13.5px]" : "text-[14.5px]",
            )}
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
              "ml-0.5 grid cursor-pointer place-items-center rounded-full transition duration-300",
              "bg-white text-[#141414] shadow-[0_8px_22px_-10px_rgba(255,255,255,0.55)]",
              "hover:scale-[1.07] hover:shadow-[0_12px_30px_-10px_rgba(255,255,255,0.6)] active:scale-95",
              compact ? "h-9 w-9" : "h-10 w-10",
              !value.trim() && "shadow-none",
            )}
          >
            <ArrowUpIcon className={compact ? "h-[17px] w-[17px]" : "h-[19px] w-[19px]"} />
          </button>
        </div>
      </div>

      {/* status strip, attached under the card */}
      <div
        className="animate-fade-up mx-3 flex items-center gap-0.5 rounded-b-[20px] border border-t-0 border-white/[0.06] bg-black/45 py-[5px] pl-2.5 pr-2 backdrop-blur-xl"
        style={{ animationDelay: "280ms" }}
      >
        <Menu
          ariaLabel="Choose working folder"
          items={DIRECTORIES}
          value={directory}
          onSelect={setDirectory}
          direction="up"
          className="flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[12.5px] font-medium text-white/55 transition-colors duration-200 hover:bg-white/[0.07] hover:text-white"
        >
          <FolderIcon className="h-[14px] w-[14px] opacity-80" />
          <span className="max-w-[30vw] truncate sm:max-w-[11rem]">
            {DIRECTORIES.find((d) => d.id === directory)?.label ?? "Local checkout"}
          </span>
        </Menu>

        <div className="flex-1" />

        <Menu
          ariaLabel="Choose branch"
          items={BRANCHES}
          value={branch}
          onSelect={setBranch}
          direction="up"
          className="flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[12.5px] font-medium text-white/55 transition-colors duration-200 hover:bg-white/[0.07] hover:text-white"
        >
          <BranchIcon className="h-[13px] w-[13px] opacity-75" />
          <span className="max-w-[24vw] truncate sm:max-w-[9rem]">
            {BRANCHES.find((b) => b.id === branch)?.label ?? "main"}
          </span>
        </Menu>

        <Menu
          ariaLabel="Choose computer"
          items={DEVICES}
          value={device}
          onSelect={setDevice}
          direction="up"
          align="right"
          className="flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[12.5px] font-medium text-white/55 transition-colors duration-200 hover:bg-white/[0.07] hover:text-white"
        >
          <DisplayIcon className="h-[14px] w-[14px] opacity-75" />
          <span className="max-w-[24vw] truncate sm:max-w-[9rem]">
            {DEVICES.find((d) => d.id === device)?.label ?? "Nairine"}
          </span>
        </Menu>
      </div>
    </div>
  );
}
