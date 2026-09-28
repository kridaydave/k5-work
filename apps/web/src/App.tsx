import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Composer,
  type ComposerSettings,
  type PromptSubmission,
  type RestoredSubmission,
} from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { PathPromptModal } from "@/components/PathPromptModal";
import { Sidebar, type Session } from "@/components/Sidebar";
import { ShieldCheckIcon } from "@/components/icons";
import { ToolCard } from "@/components/ToolCard";
import { Wallpaper } from "@/components/Wallpaper";
import { WindowChrome } from "@/components/WindowChrome";
import type {
  AttachmentRef,
  PostureGrant,
  ProjectedTranscript,
  ResolvedPostureReport,
} from "@k5-work/shared";
import { uploadAttachments } from "@/hooks/useAttachments";
import { useK5Socket } from "@/hooks/useK5Socket";
import { useProjects } from "@/hooks/useProjects";
import { readStoredTranscript, useStoredSessions } from "@/hooks/useStoredSessions";
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

/** How much of the streamed thought text is shown, oldest characters dropped. */
const THOUGHT_TAIL_CHARS = 400;

/**
 * What the seat's harness actually resolved, in words the resolver supports.
 *
 * The unverified check comes first and returns early on purpose. An unreadable
 * posture reaches the browser as `wildcardAllow: true` with nothing behind it,
 * so a caller that read that flag before asking whether it was earned would
 * render an unevidenced claim of unrestricted access — which is the exact lie
 * this replaced. A named list and a blanket wildcard are also not the same fact
 * and are never phrased the same way.
 */
function describePosture(posture: ResolvedPostureReport | null): {
  summary: string;
  grants: PostureGrant[];
} {
  if (posture === null || !posture.verified) {
    return { summary: "Permissions not verified for this seat", grants: [] };
  }
  if (posture.wildcardAllow) {
    return { summary: "Every tool allowed, with no scope", grants: [] };
  }
  // Every grant is listed, not only the named ones: a `*` grant carrying a
  // pattern is a subtree allow, and hiding it would understate the posture.
  const grants = posture.grants;
  return {
    summary:
      grants.length === 1
        ? "1 permission granted"
        : `${String(grants.length)} permissions granted`,
    grants,
  };
}

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
  // The durable task list, read over HTTP with no harness process involved. The
  // sidebar is populated from disk, not from the live session alone, so a reload
  // shows the history that is actually there.
  const { sessions: storedSessions, remove: removeStored } = useStoredSessions();
  // Re-read the transcript after a reconnect, before the new socket can deliver
  // anything: a turn that finished while the socket was down would otherwise be
  // silently lost, because the socket never replays and the store is the record.
  const rehydrate = useCallback(async (storeId: string) => {
    const { transcript } = await readStoredTranscript(storeId);
    setRehydrated(transcript);
  }, []);
  const [rehydrated, setRehydrated] = useState<ProjectedTranscript | null>(null);
  const k5 = useK5Socket({ rehydrate });
  const { state, adoptTranscript } = k5;
  // The Composer clears its textarea and its chips once the parent confirms the
  // submission went out. On the lazy-open path that confirmation cannot happen
  // inline — the seat is still opening when onSend returns — so the whole
  // submission is held here, files included: the bytes cannot be uploaded before
  // the spool exists. Bounded to one turn: a second queued prompt is refused
  // visibly rather than silently lost.
  const queuedPrompt = useRef<PromptSubmission | null>(null);
  const queueFullRef = useRef(false);
  // A refused submission pushed back into the Composer. Needed for exactly one
  // case — the seat was still opening when Send was pressed, so the answer came
  // back after onSend had already resolved — and kept out of the return value for
  // every other one.
  const [restore, setRestore] = useState<RestoredSubmission | null>(null);
  const restoreId = useRef(0);
  // A model/mode the user picked but the harness has not confirmed yet.
  const pendingChoice = useRef<{ model?: string; mode?: string }>({});
  // The last confirmed values, so a refused change can be rolled back to what
  // the seat is actually running.
  const confirmed = useRef<{ model?: string; mode?: string }>({});

  // A stored transcript replaces the visible entries until the live socket takes
  // over. Hydrated through the reducer so the shape the socket appends to is the
  // one the store produced.
  //
  // `adoptTranscript` is destructured out and depended on directly. Depending on
  // the whole `k5` object was an unbounded render loop: the hook returns a bare
  // object literal, so it is a new identity every render, and `hydrateTranscript`
  // always returns a fresh state, so the call is never a referential no-op. The
  // effect re-fired, re-rendered, and spun the tab's CPU until React tore it down.
  // `adoptTranscript` is a `useCallback` with no dependencies, so it is stable.
  useEffect(() => {
    if (rehydrated === null) return;
    adoptTranscript(rehydrated);
  }, [rehydrated, adoptTranscript]);

  /**
   * Puts a submission the parent could not deliver back into the Composer.
   *
   * The Composer owns the files, so returning them means a prop rather than
   * clearing and re-adding them. `restore.id` makes a repeated return of the same
   * files observable, so the Composer can ignore an id it has already applied.
   */
  const handBack = useCallback((submission: PromptSubmission) => {
    restoreId.current += 1;
    setRestore({
      id: restoreId.current,
      text: submission.text,
      attachments: submission.attachments,
    });
  }, []);

  /**
   * Uploads a submission's files, then prompts. Shared by the direct send and the
   * lazy-open flush so both paths read the spool the same way.
   *
   * `storeId` is k5's own id: the spool lives in the store, and the harness's
   * opaque session id addresses nothing on this side of the wire.
   */
  const deliver = useCallback(
    async (submission: PromptSubmission, storeId: string | null): Promise<boolean> => {
      let refs: AttachmentRef[] = [];
      if (submission.attachments.length > 0) {
        if (storeId === null) {
          setTranscriptNote("Attachments need an open task, so the prompt was not sent.");
          return false;
        }
        try {
          const uploaded = await uploadAttachments(storeId, submission.attachments);
          refs = uploaded.map((entry) => ({ attachmentId: entry.attachmentId }));
        } catch (cause) {
          setTranscriptNote(
            `The attachments were not uploaded: ${
              cause instanceof Error ? cause.message : "the upload did not finish"
            }`,
          );
          // The bytes are still in the Composer's hands, which is why this reports
          // a refusal instead of prompting without them.
          return false;
        }
      }
      k5.prompt(submission.text, refs);
      return true;
    },
    [k5],
  );

  const messages = state.entries;
  const active = state.entries.length > 0;
  // The existing working dots are reused rather than a new busy prop.
  const pending = state.turnStatus === "running" || state.turnStatus === "cancelling";
  // One turn's tool rail and nothing historical: the reducer clears it when the
  // next turn begins, so a card here is always work from the turn on screen.
  const liveTools = Object.values(state.tools);
  // Thought deltas accumulate for the whole turn and are never cleared by
  // `turn.completed`, so the tail is shown while the turn runs and dropped once
  // the answer is in the transcript. A harness that narrates for minutes must
  // not be able to push the whole conversation off the screen.
  const thought = state.thinking.trim();
  const thinking =
    thought.length > THOUGHT_TAIL_CHARS ? `…${thought.slice(-THOUGHT_TAIL_CHARS)}` : thought;
  // Only while a seat is live. With no seat there is no posture to report, and an
  // empty hero must stay clean, so the unverified line belongs to a session, not
  // to the screen.
  const seatPosture = state.session === "open" ? describePosture(state.posture) : null;

  // Derived from real state only. k5 has no session history yet, so the sidebar
  // shows the live session and nothing else rather than plausible-looking rows
  // for work that never happened.
  const sidebarSessions = useMemo<Session[]>(() => {
    // Real stored tasks, newest first, grouped the way the sidebar already
    // expects. Nothing here is invented: a task that was never recorded does not
    // appear, because there is no record of it to show.
    const stored: Session[] = storedSessions.map((entry) => ({
      id: entry.storeId,
      title: entry.title,
      meta: entry.turnCount === 1 ? "1 turn" : `${String(entry.turnCount)} turns`,
      group: entry.truncated ? "Incomplete" : "Tasks",
    }));
    // The live session is shown only when the store has not caught up with it yet,
    // so opening a task does not make a duplicate row appear.
    const live =
      state.storeId !== null && stored.some((entry) => entry.id === state.storeId)
        ? []
        : state.sessionId !== null && activeProject !== undefined
          ? [
              {
                id: state.sessionId,
                title: activeProject.name,
                meta: state.configOptions.find((o) => o.id === "model")?.current ?? "connecting",
                group: "This task",
              },
            ]
          : [];
    return [...live, ...stored];
  }, [activeProject, state.sessionId, state.storeId, state.configOptions, storedSessions]);

  const handleNewTask = useCallback(() => {
    queuedPrompt.current = null;
    queueFullRef.current = false;
    // A remounted Composer would otherwise replay the last refused submission,
    // resurrecting files into a task the user just walked away from.
    setRestore(null);
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
    // A prompt queued against a seat that then refused to open is now a prompt
    // that will never be sent, so its files go back to the Composer rather than
    // staying in a ref nobody renders.
    const stranded = queuedPrompt.current;
    if (stranded === null) return;
    queuedPrompt.current = null;
    queueFullRef.current = false;
    handBack(stranded);
  }, [handBack, state.session, state.sessionMessage, state.sessionReason]);

  useEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, [messages.length, pending]);

  // A healthy session clears the previous failure note.
  useEffect(() => {
    if (state.session === "open") setTranscriptNote(null);
  }, [state.session]);

  // A queued prompt is sent as soon as the session opens, so the submission
  // always reaches the harness.
  useEffect(() => {
    const queued = queuedPrompt.current;
    if (state.sessionId === null || queued === null) return;
    // Cleared before the await, not after: this effect re-runs on every render,
    // and leaving the submission queued would send it twice.
    queuedPrompt.current = null;
    queueFullRef.current = false;
    void (async () => {
      const delivered = await deliver(queued, state.storeId);
      if (delivered) setTranscriptNote(null);
      else handBack(queued);
    })();
  }, [deliver, handBack, state.sessionId, state.storeId]);

  const handleSend = useCallback(
    async (submission: PromptSubmission): Promise<boolean> => {
      const text = submission.text.trim();
      if (!text) return false;
      const busy = state.turnStatus === "running" || state.turnStatus === "cancelling";
      if (busy || queuedPrompt.current !== null) {
        if (queueFullRef.current) return false;
        queueFullRef.current = true;
        setTranscriptNote("One prompt is already queued. Wait for it to finish.");
        return false;
      }
      if (state.sessionId === null) {
        if (!activeProject) return false;
        if (state.session === "failed") {
          setTranscriptNote(
            state.sessionMessage ?? "The previous session could not be opened.",
          );
          return false;
        }
        // The seat opens lazily on the first prompt, so an empty hero costs no
        // harness process. There is no store to spool into yet, so the files ride
        // along and go up once the flush effect sees a session.
        queuedPrompt.current = { ...submission, text };
        k5.openSession(activeProject.id);
        return true;
      }
      return deliver(submission, state.storeId);
    },
    [activeProject, deliver, k5, state.session, state.sessionId, state.sessionMessage, state.storeId, state.turnStatus],
  );

  const handleRemoveSession = useCallback(
    (session: Session) => {
      // A removed task is gone from the store, so the list refreshes on its own
      // receipt rather than optimistically. Removing the task that is on screen
      // leaves it there: the live seat is not the store record, and pretending
      // otherwise would hide work the harness is still running.
      if (session.id === state.storeId) return;
      removeStored(session.id);
    },
    [removeStored, state.storeId],
  );

  const handleSelectSession = useCallback(
    (session: Session) => {
      // Continuing a stored task, rather than fabricating one. The server
      // re-validates the recorded cwd and refuses if the project has moved, so
      // this cannot quietly resume a conversation against the wrong directory.
      if (session.id === state.sessionId) return;
      setTranscriptNote(null);
      k5.loadSession(session.id);
    },
    [k5, state.sessionId],
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
          onRemoveSession={handleRemoveSession}
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
                {liveTools.length > 0 ? (
                  <ul aria-label="Tool calls in this turn" className="flex flex-col gap-1.5">
                    {liveTools.map((card) => (
                      <ToolCard key={card.toolCallId} card={card} />
                    ))}
                  </ul>
                ) : null}
                {pending && thinking.length > 0 ? (
                  <p className="break-words whitespace-pre-wrap text-[12px] leading-relaxed text-white/35">
                    {thinking}
                  </p>
                ) : null}
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

            {transcriptNote ? (
              <div
                role="status"
                className="mx-auto w-full max-w-[800px] pb-2 text-[12px] text-white/55"
              >
                {transcriptNote}
              </div>
            ) : null}

            {/* A native disclosure, so closing it needs no state and no new
                component: the affordance the Composer's permissions pill always
                implied now has a way to show its evidence and a way to put it
                away. The summary is the claim, the body is the scope. */}
            {seatPosture ? (
              <div className="mx-auto w-full max-w-[800px] pb-2 text-[12px] text-white/55">
                <details>
                  <summary
                    className={cn(
                      "flex w-fit cursor-pointer list-none items-center gap-1.5",
                      "transition-colors duration-200 hover:text-white/75",
                    )}
                  >
                    <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 text-white/45" />
                    <span className="truncate">{seatPosture.summary}</span>
                  </summary>
                  {seatPosture.grants.length > 0 ? (
                    <ul className="mt-1.5 flex flex-col gap-0.5">
                      {seatPosture.grants.map((grant) => (
                        <li
                          key={`${grant.permission} ${grant.pattern}`}
                          className="break-words text-white/40"
                        >
                          <span className="text-white/60">{grant.permission}</span>
                          <span> — {grant.pattern}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </details>
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
                restore={restore}
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
