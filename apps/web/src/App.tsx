import { useCallback, useEffect, useRef, useState } from "react";
import {
  Composer,
  type ComposerSettings,
  type PromptAttachment,
  type PromptSubmission,
} from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { PaperclipIcon } from "@/components/icons";
import { PathPromptModal } from "@/components/PathPromptModal";
import { Sidebar, type Session } from "@/components/Sidebar";
import { Wallpaper } from "@/components/Wallpaper";
import { WindowChrome } from "@/components/WindowChrome";
import { useProjects } from "@/hooks/useProjects";
import { cn } from "@/utils/cn";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments: PromptAttachment[];
};

const REPLY_DELAY_MS = 1400;
const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = {
  model: "sonnet",
  thinking: "medium",
  permissions: "review",
};

function simulatedReply(prompt: string, followUp: boolean): string {
  const head = prompt.length > 64 ? `${prompt.slice(0, 64).trimEnd()}…` : prompt;
  if (/list|steps|items|one.*two/i.test(prompt)) {
    return `Here is the breakdown for "${head}":\n\n- **Phase 1**: Initial discovery and workspace mapping\n- **Phase 2**: Implementation and targeted testing\n- **Phase 3**: Verification and polish\n\n\`\`\`ts\nconst status = "ready";\nconsole.log({ status });\n\`\`\`\n\nTell me what to adjust.`;
  }
  if (!followUp) {
    return `Here is a first pass at "${head}":\n\n- Mapped the relevant files in this workspace\n- Drafted the smallest change that fits the existing patterns\n\nTell me what to adjust.`;
  }
  return `I folded that into "${head}":\n\n- Updated the current draft\n- Re-ran the targeted checks\n\nSend the next change when ready.`;
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [composerSettings, setComposerSettings] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [projectPromptOpen, setProjectPromptOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const firstRect = useRef<DOMRect | null>(null);
  const timers = useRef<number[]>([]);
  const {
    projects,
    activeProject,
    loading: projectsLoading,
    error: projectsError,
    selectProject,
    openPath,
  } = useProjects();

  const active = messages.length > 0;
  const pending = pendingCount > 0;

  const cancelReplies = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    firstRect.current = null;
    setPendingCount(0);
  }, []);

  const handleNewTask = useCallback(() => {
    cancelReplies();
    setMessages([]);
    setSessionKey((current) => current + 1);
    requestAnimationFrame(() => {
      document.getElementById("composer-input")?.focus();
    });
  }, [cancelReplies]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && !event.altKey && !event.shiftKey && key === "b") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) setSidebarOpen((current) => !current);
        return;
      }
      if (commandKey && event.altKey && !event.shiftKey && key === "n") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) handleNewTask();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handleNewTask]);

  useEffect(() => {
    return () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  useEffect(() => {
    const first = firstRect.current;
    firstRect.current = null;
    const element = composerWrapRef.current;
    if (!first || !element || messages.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const last = element.getBoundingClientRect();
    const offsetY = first.top - last.top;
    if (Math.abs(offsetY) < 4) return;
    element.animate(
      [{ transform: `translateY(${offsetY}px)` }, { transform: "translateY(0)" }],
      {
        duration: 460,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    );
  }, [messages.length]);

  useEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, [messages.length, pending]);

  const handleSend = useCallback(
    (submission: PromptSubmission) => {
      const text = submission.text.trim();
      if (!text) return;
      firstRect.current = composerWrapRef.current?.getBoundingClientRect() ?? null;
      const followUp = messages.length > 0;
      const attachments: PromptAttachment[] = submission.attachments.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
      }));
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-user`,
          role: "user",
          text,
          attachments,
        },
      ]);
      setPendingCount((count) => count + 1);
      const id = window.setTimeout(() => {
        setPendingCount((count) => Math.max(0, count - 1));
        setMessages((current) => [
          ...current,
          {
            id: `${Date.now()}-assistant`,
            role: "assistant",
            text: simulatedReply(text, followUp),
            attachments: [],
          },
        ]);
      }, REPLY_DELAY_MS);
      timers.current.push(id);
    },
    [messages.length],
  );

  const handleSelectSession = useCallback(
    (session: Session) => {
      cancelReplies();
      setSessionKey((current) => current + 1);
      setMessages([
        { id: `${Date.now()}-user`, role: "user", text: session.title, attachments: [] },
        {
          id: `${Date.now()}-assistant`,
          role: "assistant",
          text: simulatedReply(session.title, false),
          attachments: [],
        },
      ]);
    },
    [cancelReplies],
  );

  const handleSelectProject = useCallback(
    (id: string) => {
      selectProject(id);
      handleNewTask();
    },
    [handleNewTask, selectProject],
  );

  const handleOpenProject = useCallback(() => {
    setProjectPromptOpen(true);
  }, []);

  const handleProjectPath = useCallback(
    async (path: string) => {
      await openPath(path);
      handleNewTask();
    },
    [handleNewTask, openPath],
  );

  return (
    <div className="relative min-h-[100dvh] w-full bg-ink-1000 font-sans antialiased">
      <h1 className="sr-only">k5-work local agent workspace</h1>

      <div
        className="relative isolate flex h-[100dvh] w-full overflow-hidden bg-ink-950"
      >
        <Wallpaper active={active} />

        <Sidebar
          open={sidebarOpen}
          projects={projects}
          activeProjectId={activeProject?.id}
          projectsLoading={projectsLoading}
          projectsError={projectsError}
          onClose={() => setSidebarOpen(false)}
          onToggle={() => setSidebarOpen((current) => !current)}
          onNewTask={handleNewTask}
          onOpenProject={handleOpenProject}
          onSelectProject={handleSelectProject}
          onSelectSession={handleSelectSession}
        />

        <section className="relative isolate flex min-w-0 flex-1 flex-col">
          <WindowChrome
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((current) => !current)}
          />

          <main
            ref={mainRef}
            className="thin-scroll relative z-10 flex flex-1 flex-col overflow-y-auto px-4 pt-20 sm:px-8 lg:px-10"
          >
            {active ? (
              <div
                aria-live="polite"
                className="mx-auto flex w-full max-w-[800px] flex-1 flex-col justify-end gap-4 py-6"
              >
                {messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="animate-fade-up flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-md border border-white/10 bg-white/[0.07] px-4 py-2.5 text-[14px] leading-relaxed text-white/90">
                        <Markdown content={message.text} variant="user" />
                        {message.attachments.length > 0 ? (
                          <div className="mt-2 flex items-start gap-1.5 border-t border-white/10 pt-2 text-[11.5px] text-white/45">
                            <PaperclipIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{message.attachments.map((file) => file.name).join(", ")}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div key={message.id} className="animate-fade-up max-w-[90%]">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">
                        k5 agent
                      </p>
                      <Markdown content={message.text} variant="assistant" />
                    </div>
                  ),
                )}
                {pending ? (
                  <div className="flex items-center gap-1.5 py-1" aria-label="The agent is working">
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40"
                        style={{ animationDelay: `${dot * 180}ms` }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div
              ref={composerWrapRef}
              className={cn(
                "mx-auto w-full max-w-[800px]",
                active
                  ? "sticky bottom-0 z-20 mt-4 bg-[linear-gradient(to_top,rgba(8,10,14,0.96)_55%,rgba(8,10,14,0))] pb-[clamp(1rem,4vh,2.5rem)] pt-3"
                  : "my-auto py-10",
              )}
            >
              <Composer
                key={sessionKey}
                activeProject={activeProject}
                projects={projects}
                settings={composerSettings}
                compact={active}
                onRequestProject={handleOpenProject}
                onSelectProject={handleSelectProject}
                onSettingsChange={setComposerSettings}
                onSend={handleSend}
              />
            </div>
          </main>
        </section>

        <PathPromptModal
          open={projectPromptOpen}
          onClose={() => setProjectPromptOpen(false)}
          onSubmit={handleProjectPath}
        />
      </div>
    </div>
  );
}
