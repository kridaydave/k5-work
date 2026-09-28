import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_VIEW_STATE,
  applyServerEvent,
  beginTurn,
  type K5ViewState,
  type ServerEvent,
  type ToolCard as ToolCardState,
} from "@k5-work/shared";
import App from "@/App";
import { ToolCard } from "./ToolCard";
import type { K5Socket } from "@/hooks/useK5Socket";

function renderCard(overrides: Partial<ToolCardState> = {}) {
  const card: ToolCardState = {
    toolCallId: "tool-1",
    title: "Read src/App.tsx",
    status: "completed",
    lifecycle: "active",
    ...overrides,
  };
  render(
    <ul>
      <ToolCard card={card} />
    </ul>,
  );
  return card;
}

describe("a tool card states what happened", () => {
  it("does not present a finished call as still running", () => {
    renderCard({ status: "completed" });
    const card = screen.getByRole("listitem", { name: "Read src/App.tsx: Completed" });
    // Both halves matter: a screen reader only gets the aria state and a sighted
    // user only gets the word, so neither alone is the whole answer.
    expect(card.getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getByText("Completed")).toBeTruthy();
  });

  it("marks a call that is still live as busy", () => {
    renderCard({ status: "in_progress" });
    const card = screen.getByRole("listitem", { name: "Read src/App.tsx: Running" });
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("holds a queued call short of running", () => {
    renderCard({ status: "pending" });
    expect(screen.getByRole("listitem", { name: "Read src/App.tsx: Queued" })).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("tells a failure from a completion", () => {
    renderCard({ status: "failed" });
    const failed = screen.getByRole("listitem", { name: "Read src/App.tsx: Failed" });
    expect(failed.getAttribute("aria-busy")).toBeNull();
    expect(failed.getAttribute("data-state")).toBe("failed");
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("tells a cancelled call from a completion, even when the harness left it in progress", () => {
    // The reducer's terminal-turn correction: the harness sent no further
    // update, so its own last word was `in_progress`. Reading the status and
    // ignoring the lifecycle is exactly the bug this card exists to avoid.
    renderCard({ status: "in_progress", lifecycle: "cancelled" });
    const cancelled = screen.getByRole("listitem", { name: "Read src/App.tsx: Cancelled" });
    expect(cancelled.getAttribute("aria-busy")).toBeNull();
    expect(cancelled.getAttribute("data-state")).toBe("cancelled");
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("tells a call the seat took away from a finished one", () => {
    renderCard({ status: "in_progress", lifecycle: "orphaned" });
    const orphaned = screen.getByRole("listitem", { name: "Read src/App.tsx: Interrupted" });
    expect(orphaned.getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("still names a call the harness left untitled", () => {
    renderCard({ title: "   " });
    expect(screen.getByRole("listitem", { name: "Untitled tool call: Completed" })).toBeTruthy();
  });

  it("keeps a long title whole instead of breaking the row", () => {
    const title = ["npm run", ...Array<string>(16).fill("typecheck-and-build-everything")].join(
      " ",
    );
    renderCard({ title });
    // jsdom lays nothing out, so a title surviving intact in the accessible name
    // and in the DOM is the only observable half of the promise; the other half
    // is the CSS truncation the Composer chips already use.
    const card = screen.getByRole("listitem", { name: `${title}: Completed` });
    const shown = within(card).getByTitle(title);
    expect(shown.textContent).toBe(title);
    expect(shown.className).toContain("truncate");
  });
});

// The transcript renders the live turn's rail, so the wiring is proven against
// what the reducer really produces rather than a hand-built state object.
const socket: { current: K5Socket | null } = { current: null };

vi.mock("@/hooks/useK5Socket", () => ({ useK5Socket: () => socket.current }));
vi.mock("@/hooks/useProjects", () => ({
  useProjects: () => ({
    projects: [{ id: "p-1", name: "k5-work", path: "/home/k5/code/k5-work" }],
    activeProject: { id: "p-1", name: "k5-work", path: "/home/k5/code/k5-work" },
    loading: false,
    error: null,
    selectProject: () => {},
    openPath: () => {},
  }),
}));
vi.mock("@/hooks/useStoredSessions", () => ({
  useStoredSessions: () => ({
    sessions: [],
    loading: false,
    error: null,
    refresh: () => {},
    remove: async () => false,
  }),
}));

const TURN_ID = "t-1";

/** Every App query is scoped to the transcript, because the sidebar has lists too. */
function transcript(): HTMLElement {
  return screen.getByRole("main");
}

function beginTestTurn(): K5ViewState {
  return beginTurn(INITIAL_VIEW_STATE, TURN_ID, "run the tests");
}

function withEvents(state: K5ViewState, ...events: ServerEvent[]): K5ViewState {
  return events.reduce((current, event) => applyServerEvent(current, event), state);
}

function toolUpdate(overrides: Partial<ToolCardState> = {}): ServerEvent {
  return {
    type: "tool.updated",
    sessionId: "s-1",
    turnId: TURN_ID,
    toolCallId: "tool-1",
    title: "Read src/App.tsx",
    status: "in_progress",
    lifecycle: "active",
    ...overrides,
  };
}

function endTurn(): ServerEvent {
  return { type: "turn.completed", sessionId: "s-1", turnId: TURN_ID, stopReason: "end_turn" };
}

function renderApp(state: K5ViewState) {
  socket.current = {
    state,
    connected: true,
    openSession: () => {},
    prompt: () => {},
    cancel: () => {},
    closeSession: () => {},
    newTask: () => {},
    configure: () => {},
    adoptTranscript: () => {},
    listSessions: () => false,
    loadSession: () => false,
  };
  return render(<App />);
}

beforeEach(() => {
  // jsdom implements neither the Web Animations API the composer slide uses nor
  // Element.scrollTo. A browser has both, so the gap is filled rather than
  // working around it by testing a copy of the App.
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value: () => ({}),
  });
  Element.prototype.scrollTo = () => {};
});

describe("tool calls in the transcript", () => {
  it("renders nothing at all for a turn with no tool calls", () => {
    // An empty container or a reserved row would push the answer down for work
    // that never happened.
    renderApp(beginTestTurn());
    expect(within(transcript()).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Tool calls in this turn" })).toBeNull();
  });

  it("shows a live tool call while the turn runs", () => {
    renderApp(withEvents(beginTestTurn(), toolUpdate()));
    expect(
      within(transcript()).getByRole("listitem", { name: "Read src/App.tsx: Running" }),
    ).toBeTruthy();
  });

  it("settles the card when the turn ends instead of spinning forever", () => {
    renderApp(withEvents(beginTestTurn(), toolUpdate(), endTurn()));
    const card = within(transcript()).getByRole("listitem", {
      name: "Read src/App.tsx: Cancelled",
    });
    expect(card.getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("leaves a call that really finished reading as finished", () => {
    renderApp(withEvents(beginTestTurn(), toolUpdate({ status: "completed" }), endTurn()));
    expect(
      within(transcript()).getByRole("listitem", { name: "Read src/App.tsx: Completed" }),
    ).toBeTruthy();
  });

  it("drops the rail when the next turn begins, so no stale card looks live", () => {
    const first = withEvents(beginTestTurn(), toolUpdate());
    renderApp(beginTurn(first, "t-2", "and now the docs"));
    expect(within(transcript()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows nothing before the first prompt, leaving the empty hero alone", () => {
    renderApp(INITIAL_VIEW_STATE);
    expect(screen.getByRole("heading", { name: /What should we build in/ })).toBeTruthy();
    expect(within(transcript()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("streams the harness's thought text while the turn runs, then drops it", () => {
    const running = withEvents(beginTestTurn(), {
      type: "turn.delta",
      sessionId: "s-1",
      turnId: TURN_ID,
      stream: "thought",
      text: "checking the reducer first",
    });
    const view = renderApp(running);
    expect(screen.getByText("checking the reducer first")).toBeTruthy();
    view.unmount();

    renderApp(withEvents(running, endTurn()));
    // `turn.completed` never clears `thinking`, so the card is what has to stop
    // showing narration once the answer is in the transcript.
    expect(screen.queryByText("checking the reducer first")).toBeNull();
  });
});
