import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Composer,
  type ComposerSettings,
  type PromptSubmission,
} from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { PermissionPrompt } from "@/components/PermissionPrompt";
import { PathPromptModal } from "@/components/PathPromptModal";
import { Sidebar, type Session } from "@/components/Sidebar";
import { Wallpaper } from "@/components/Wallpaper";
import { WindowChrome } from "@/components/WindowChrome";
import { useK5Socket } from "@/hooks/useK5Socket";
import { useProjects } from "@/hooks/useProjects";
import { cn } from "@/utils/cn";

// Only `full` is servable: OpenCode 1.18.31 resolves a blanket `*: allow` and
// drops any config that would narrow it, so a narrower pill would be a promise
// k5 cannot keep. See docs/posture-and-trust-decisions.md.
// Model and mode start empty and are filled from what the harness advertises.
// Naming a vendor model up front would offer a choice that fails for anyone
// without those credentials.
const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = {
  model: "",
  mode: "",
  permissions: "full",
};

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);
  const [composerSettings, setComposerSettings] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [projectPromptOpen, setProjectPromptOpen] = useState(false);
  // Pre-session failures (auth, seat cap, plugin refusal) must be visible, or a
  // prompt looks like it is doing nothing.
  const [transcriptNote, setTranscriptNote] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const {
    projects,
    activeProject,
    loading: projectsLoading,
    error: projectsError,
    selectProject,
    openPath,
  } = useProjects();
  const k5 = useK5Socket();
  const { state } = k5;
  // The Composer clears its textarea on send and onSend returns void, so a
  // prompt issued while the seat is still opening must be held here rather than
  // dropped. Bounded to one turn: a second queued prompt is refused visibly
  // rather than silently lost.
  const queuedPrompt = useRef<string | null>(null);
  const queueFullRef = useRef(false);
  // A model/mode the user picked but the harness has not confirmed yet.
  const pendingChoice = useRef<{ model?: string; mode?: string }>({});
  // The last confirmed values, so a refused change can be rolled back to what
  // the seat is actually running.
  const confirmed = useRef<{ model?: string; mode?: string }>({});

  const messages = state.entries;
  const active = state.entries.length > 0;
  // The existing working dots are reused rather than a new busy prop.
  const pending = state.turnStatus === "running" || state.turnStatus === "cancelling";

  // Derived from real state only. k5 has no session history yet, so the sidebar
  // shows the live session and nothing else rather than plausible-looking rows
  // for work that never happened.
  const sidebarSessions = useMemo<Session[]>(() => {
    if (state.sessionId === null || activeProject === undefined) return [];
    const model = state.configOptions.find((o) => o.id === "model")?.current;
    const title = activeProject.name;
    return [
      {
        id: state.sessionId,
        title,
        meta: model ?? "connecting",
        group: "This task",
      },
    ];
  }, [activeProject, state.sessionId, state.configOptions]);

  const handleNewTask = useCallback(() => {
    queuedPrompt.current = null;
    queueFullRef.current = false;
    pendingChoice.current = {};
    confirmed.current = {};
    // A new task must clear any note; a stale error above an empty hero reads as
    // a current failure.
    setTranscriptNote(null);
    k5.newTask();
    setSessionKey((current) => current + 1);
    requestAnimationFrame(() => {
      document.getElementById("composer-input")?.focus();
    });
  }, [k5]);

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
    const element = composerWrapRef.current;
    if (!element || messages.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const last = element.getBoundingClientRect();
    if (Math.abs(last.top) < 0.5) return;
    element.animate(
      [{ transform: `translateY(${last.top}px)` }, { transform: "translateY(0)" }],
      {
        duration: 460,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    );
  }, [messages.length]);

  // A failed session is a state, not a silent nothing.
  useEffect(() => {
    if (state.session !== "failed") return;
    setTranscriptNote(state.sessionMessage ?? `Session failed: ${state.sessionReason ?? "unknown"}`);
  }, [state.session, state.sessionMessage, state.sessionReason]);

  useEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, [messages.length, pending]);

  // A queued prompt is sent as soon as the session opens, so the submission
  // always reaches the harness.
  useEffect(() => {
    // A healthy session clears the previous failure note.
    if (state.session === "open") setTranscriptNote(null);
  }, [state.session]);

  useEffect(() => {
    const queued = queuedPrompt.current;
    if (state.sessionId === null || queued === null) return;
    setTranscriptNote(null);
    queuedPrompt.current = null;
    queueFullRef.current = false;
    k5.prompt(queued);
  }, [k5, state.sessionId]);

  const handleSend = useCallback(
    (submission: PromptSubmission) => {
      const text = submission.text.trim();
      if (!text) return;
      const busy = state.turnStatus === "running" || state.turnStatus === "cancelling";
      if (busy || queuedPrompt.current !== null) {
        if (queueFullRef.current) return;
        queueFullRef.current = true;
        setTranscriptNote("One prompt is already queued. Wait for it to finish.");
        return;
      }
      if (state.sessionId === null) {
        if (!activeProject) return;
        if (state.session === "failed") {
          setTranscriptNote(
            state.sessionMessage ?? "The previous session could not be opened.",
          );
          return;
        }
        // The seat opens lazily on the first prompt, so an empty hero costs no
        // harness process.
        queuedPrompt.current = text;
        k5.openSession(activeProject.id);
        return;
      }
      k5.prompt(text);
    },
    [activeProject, k5, state.session, state.sessionId, state.sessionMessage, state.turnStatus],
  );

  const handleSelectSession = useCallback(
    (session: Session) => {
      // The sidebar still lists placeholder sessions from the original build.
      // Selecting one used to fabricate a transcript; now that it would also
      // close a live seat, it does nothing at all. Durable session history is
      // Phase 4 work, and a placeholder that destroys real work is worse than
      // an honest no-op.
      void session;
    },
    [],
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
          sessions={sidebarSessions}
          connection={state.connection}
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

            {state.pendingPermission ? (
              <PermissionPrompt
                request={state.pendingPermission}
                onDecide={(optionId) => k5.decidePermission(optionId)}
              />
            ) : null}

            {transcriptNote ? (
              <div
                role="status"
                className="mx-auto w-full max-w-[800px] pb-2 text-[12px] text-white/55"
              >
                {transcriptNote}
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
                configOptions={state.session === "open" ? state.configOptions : null}
                compact={active}
                onRequestProject={handleOpenProject}
                onSelectProject={handleSelectProject}
                onSettingsChange={(next) => {
                  const sessionId = state.sessionId;
                  for (const id of ["model", "mode"] as const) {
                    const value = next[id];
                    if (!value || value === composerSettings[id]) continue;
                    if (sessionId) {
                      // Marked pending so the harness's echoed current value
                      // does not revert the pick before it is applied.
                      pendingChoice.current[id] = value;
                      k5.configure(sessionId, id, value);
                    } else {
                      confirmed.current[id] = value;
                    }
                  }
                  setComposerSettings(next);
                }}
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
