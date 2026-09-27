import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
