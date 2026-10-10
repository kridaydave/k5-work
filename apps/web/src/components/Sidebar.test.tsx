import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar, type Session } from "./Sidebar";
import type { Project } from "@k5-work/shared";

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props: React.ComponentProps<typeof Sidebar> = {
    open: true,
    projects: [] as Project[],
    onClose: () => {},
    onToggle: () => {},
    onNewTask: () => {},
    onOpenProject: () => {},
    onSelectProject: () => {},
    onSelectSession: () => {},
    sessions: [],
    ...overrides,
  };
  render(<Sidebar {...props} />);
  return props;
}

/**
 * Scoped to the Tasks section: "k5-work" is also the brand in the header, so an
 * unscoped text query would match the wrong element.
 */
function tasks(): HTMLElement {
  const section = screen.getByRole("heading", { name: "Tasks" }).closest("section");
  if (!section) throw new Error("the Tasks section is missing");
  return section;
}

const liveSession: Session[] = [
  { id: "s-1", title: "k5-work", meta: "opencode/space-bunny-free", group: "This task" },
];

describe("Sidebar task list", () => {
  it("invents no tasks when there are none", () => {
    // The list used to be a hardcoded fixture, so the UI showed eight confident
    // sessions for work that never happened.
    renderSidebar();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("No tasks yet.")).toBeTruthy();
  });

  it("shows only the sessions it is given", () => {
    renderSidebar({ sessions: liveSession });
    expect(within(tasks()).getByText("k5-work")).toBeTruthy();
    expect(within(tasks()).getByText("opencode/space-bunny-free")).toBeTruthy();
    expect(within(tasks()).queryByText("Fable 5.1")).toBeNull();
    expect(within(tasks()).queryByText("Refactor the composer state")).toBeNull();
  });

  it("distinguishes an empty workspace from a search that matched nothing", () => {
    // "No tasks yet." while a search misses would be a lie: a task exists.
    renderSidebar({ sessions: liveSession });
    fireEvent.change(screen.getByPlaceholderText("Search tasks"), {
      target: { value: "zzzz-no-such-task" },
    });
    expect(within(tasks()).getByText("No matching tasks.")).toBeTruthy();
    expect(within(tasks()).queryByText("No tasks yet.")).toBeNull();
  });

  it("filters sessions by title and by model", () => {
    renderSidebar({
      sessions: [
        ...liveSession,
        { id: "s-2", title: "other project", meta: "opencode/big-pickle", group: "This task" },
      ],
    });
    fireEvent.change(screen.getByPlaceholderText("Search tasks"), {
      target: { value: "big-pickle" },
    });
    expect(within(tasks()).getByText("other project")).toBeTruthy();
    expect(within(tasks()).queryByText("k5-work")).toBeNull();
  });

  it("hands the clicked session back to the caller", () => {
    const seen: Session[] = [];
    renderSidebar({ sessions: liveSession, onSelectSession: (s) => seen.push(s) });
    fireEvent.click(within(tasks()).getByText("k5-work"));
    expect(seen.map((s) => s.id)).toEqual(["s-1"]);
  });
});

describe("Sidebar search results", () => {
  const twoThreads: Session[] = [
    {
      id: "s-1",
      title: "write the docking plan",
      meta: "2 turns",
      group: "Work",
      snippets: [
        { role: "prompt", text: "find the zeppelin manifest", seq: 1 },
        { role: "reply", text: "the zeppelin docks at pier four", seq: 2 },
      ],
    },
    {
      id: "s-2",
      title: "fuel consumption",
      meta: "1 turn",
      group: "Work",
      snippets: [{ role: "reply", text: "a zeppelin burns very little", seq: 3 }],
    },
  ];

  it("shows the matched lines, and says which side said them", () => {
    // Two threads share a phrase. The snippet is what tells them apart, and
    // naming the side is what makes the line readable without opening either.
    renderSidebar({ sessions: twoThreads, searchActive: true });
    const section = tasks();
    expect(within(section).getByText(/you: find the zeppelin manifest/)).toBeTruthy();
    expect(within(section).getByText(/agent: the zeppelin docks at pier four/)).toBeTruthy();
    expect(within(section).getByText(/agent: a zeppelin burns very little/)).toBeTruthy();
  });

  it("keeps a plain list read free of snippet lines", () => {
    // The same rows without snippets are what a list read looks like, and an
    // empty array read as "searched and found nothing" would be a lie about a
    // read that never searched.
    renderSidebar({ sessions: twoThreads.map(({ snippets: _drop, ...rest }) => rest) });
    expect(within(tasks()).queryByText(/you: /)).toBeNull();
    expect(within(tasks()).queryByText(/agent: /)).toBeNull();
  });

  it("reports a search that missed as a search, not an empty workspace", () => {
    // The box leads the server's answer while a query is in flight, so the
    // empty state follows what the store said rather than what was typed.
    renderSidebar({ sessions: [], searchActive: true });
    expect(within(tasks()).getByText("No matching tasks.")).toBeTruthy();
    expect(within(tasks()).queryByText("No tasks yet.")).toBeNull();
  });

  it("keeps a search hit whose title does not contain the query", () => {
    // The store matched the transcript, and the row it returned is the answer.
    // Filtering a search answer locally again could only remove hits: this row
    // has no snippet line (its matched line was cut from the transcript) and
    // no title match, and it used to vanish with nothing on screen to say why.
    renderSidebar({
      sessions: [{ id: "s-1", title: "an unrelated title", meta: "1 turn", group: "Work" }],
      searchActive: true,
    });
    fireEvent.change(screen.getByPlaceholderText("Search tasks"), {
      target: { value: "zeppelin" },
    });
    expect(within(tasks()).getByText("an unrelated title")).toBeTruthy();
    expect(within(tasks()).queryByText("No matching tasks.")).toBeNull();
  });

  it("hands the typed query to the caller, debounced", () => {
    // The store searches the transcripts, so the query has to leave the
    // component. Debounced, because one request per keystroke is a request
    // nobody asked for, and the raw text stays here so a keystroke does not
    // re-render everything the app owns.
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      renderSidebar({ sessions: twoThreads, onSearchChange: (value) => seen.push(value) });
      fireEvent.change(screen.getByPlaceholderText("Search tasks"), {
        target: { value: "zeppelin" },
      });
      expect(seen, "nothing leaves before the typing pauses").toEqual([]);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(seen, "and exactly the trimmed query when it does").toEqual(["zeppelin"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
