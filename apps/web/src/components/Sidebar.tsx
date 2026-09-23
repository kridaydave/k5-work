import { useEffect, useState } from "react";
import { FolderIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { cn } from "@/utils/cn";
import type { Project } from "@k5-work/shared";

export type Session = { title: string; meta: string };

const GROUPS: { label: string; sessions: Session[] }[] = [
  {
    label: "Today",
    sessions: [
      { title: "Fable 5.1", meta: "2m · true · 300K · Low" },
      { title: "Refactor the composer state", meta: "26m · Sonnet 4.5" },
      { title: "Sunset artwork pass", meta: "1h · Opus 4.5" },
    ],
  },
  {
    label: "Yesterday",
    sessions: [
      { title: "Cowork window polish", meta: "14h · Sonnet 4.5" },
      { title: "Dependency triage", meta: "18h · Haiku 4.5" },
    ],
  },
  {
    label: "Earlier this week",
    sessions: [
      { title: "Kepler migration plan", meta: "Tue · Opus 4.5" },
      { title: "Weekly review notes", meta: "Mon · Sonnet 4.5" },
    ],
  },
];

type SidebarProps = {
  open: boolean;
  projects: Project[];
  activeProjectId?: string;
  projectsLoading?: boolean;
  projectsError?: string;
  onClose: () => void;
  onToggle: () => void;
  onNewTask: () => void;
  onOpenProject: () => void;
  onSelectProject: (id: string) => void;
  onSelectSession: (session: Session) => void;
};

export function Sidebar({
  open,
  projects,
  activeProjectId,
  projectsLoading = false,
  projectsError = "",
  onClose,
  onToggle,
  onNewTask,
  onOpenProject,
  onSelectProject,
  onSelectSession,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const [compactViewport, setCompactViewport] = useState(
    () => window.matchMedia("(max-width: 1023px)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setCompactViewport(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const hidden = !open && compactViewport;
  const normalizedSearch = search.trim().toLowerCase();
  const groups = GROUPS.map((group) => ({
    ...group,
    sessions: group.sessions.filter(
      (session) =>
        !normalizedSearch ||
        session.title.toLowerCase().includes(normalizedSearch) ||
        session.meta.toLowerCase().includes(normalizedSearch),
    ),
  })).filter((group) => group.sessions.length > 0);
  const sessions = groups.flatMap((group) => group.sessions);

  const runAndClose = (action: () => void) => {
    action();
    if (compactViewport) onClose();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close sidebar"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={cn(
          "absolute inset-0 z-30 bg-black/60 backdrop-blur-[3px] transition-opacity duration-200 lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        aria-label="Workspace sidebar"
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        className={cn(
          "glass-panel group/sidebar relative z-40 flex h-full shrink-0 flex-col overflow-visible border-r border-white/[0.07] transition-[width,transform] duration-[320ms] [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] lg:relative lg:translate-x-0 lg:rounded-l-[26px]",
          open
            ? "w-[86vw] max-w-[300px] lg:w-[276px] lg:max-w-none"
            : "w-[68px] max-w-[68px] -translate-x-full",
        )}
      >
        {open ? (
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (Ctrl+B)"
            onClick={onToggle}
            className="absolute -right-3 top-[74px] z-10 grid h-6 w-6 cursor-pointer place-items-center rounded-full border border-white/10 bg-[#111] text-[15px] leading-none text-white/55 opacity-0 shadow-[0_8px_24px_-10px_rgba(0,0,0,0.9)] transition hover:text-white focus-visible:opacity-100 group-hover/sidebar:opacity-100"
          >
            <span aria-hidden="true">&lt;</span>
          </button>
        ) : null}

        <div className="flex h-[68px] shrink-0 items-center px-3">
          <button
            type="button"
            aria-label={open ? "k5-work" : "Expand sidebar"}
            title={open ? "k5-work" : "Expand sidebar (Ctrl+B)"}
            onClick={() => {
              if (!open) onToggle();
            }}
            className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-xl p-1 text-left transition hover:bg-white/[0.05]"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-white text-[11px] font-black tracking-[-0.04em] text-black">
              K5
            </span>
            {open ? (
              <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-white/90">k5-work</span>
            ) : null}
          </button>
        </div>

        <div className="space-y-2 px-3">
          <button
            type="button"
            aria-label="New task"
            title="New task (Ctrl+Alt+N)"
            onClick={() => runAndClose(onNewTask)}
            className={cn(
              "flex w-full cursor-pointer items-center rounded-xl border border-white/[0.08] bg-white/[0.045] text-white/80 transition duration-200 hover:border-white/20 hover:bg-white/[0.09] active:scale-[0.99]",
              open ? "gap-2 px-3 py-2.5" : "h-10 w-10 justify-center p-0",
            )}
          >
            <PlusIcon className="h-4 w-4 shrink-0" />
            {open ? (
              <>
                <span className="text-[13px] font-medium">New task</span>
                <span className="ml-auto text-[10px] text-white/30">Ctrl Alt N</span>
              </>
            ) : null}
          </button>

          {open ? (
            <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.035] px-3 py-2 transition-colors duration-200 focus-within:border-white/20">
              <SearchIcon className="h-4 w-4 shrink-0 text-white/40" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search tasks"
                aria-label="Search tasks"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-white/90 placeholder:text-white/35 focus:outline-none"
              />
            </div>
          ) : (
            <button
              type="button"
              aria-label="Expand and search tasks"
              title="Search tasks"
              onClick={onToggle}
              className="grid h-10 w-full cursor-pointer place-items-center rounded-xl text-white/45 transition hover:bg-white/[0.07] hover:text-white"
            >
              <SearchIcon className="h-4 w-4" />
            </button>
          )}
        </div>

        <nav className="thin-scroll mt-5 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-5">
          {open ? (
            <section className="mb-5">
              <div className="mb-2 flex items-center justify-between px-2">
                <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white/30">Projects</h2>
                <button
                  type="button"
                  aria-label="Open project folder"
                  title="Open project folder"
                  onClick={onOpenProject}
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-white/35 transition hover:bg-white/[0.08] hover:text-white"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              {projectsError ? (
                <p role="alert" className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-2.5 py-2 text-[11.5px] leading-relaxed text-white/50">
                  {projectsError}. Open a folder to continue.
                </p>
              ) : null}
              {projectsLoading ? (
                <p className="px-2 py-2 text-[12px] text-white/35">Finding projects…</p>
              ) : projects.length > 0 ? (
                <>
                  <ul className="space-y-0.5">
                  {projects.slice(0, 6).map((project) => {
                    const selected = project.id === activeProjectId;
                    return (
                      <li key={project.path}>
                        <button
                          type="button"
                          title={project.meta ?? project.path}
                          onClick={() => runAndClose(() => onSelectProject(project.id))}
                          className={cn(
                            "flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors duration-200 hover:bg-white/[0.07]",
                            selected && "bg-white/[0.07]",
                          )}
                        >
                          <FolderIcon className={cn("h-4 w-4 shrink-0", selected ? "text-white/85" : "text-white/40")} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-white/80">{project.name}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-white/30">
                              {project.branch ?? project.path}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  </ul>
                  {projects.length > 6 ? (
                    <p className="px-2.5 py-2 text-[11.5px] text-white/30">
                      +{projects.length - 6} more projects
                    </p>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={onOpenProject}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12.5px] text-white/45 transition hover:bg-white/[0.07] hover:text-white"
                >
                  <FolderIcon className="h-4 w-4" />
                  Choose a project folder
                </button>
              )}
            </section>
          ) : projects.length > 0 ? (
            <section aria-label="Projects" className="mb-4 space-y-1">
              {projects.slice(0, 5).map((project) => (
                <button
                  key={project.path}
                  type="button"
                  aria-label={`Open ${project.name}`}
                  title={project.name}
                  onClick={() => runAndClose(() => onSelectProject(project.id))}
                  className={cn(
                    "grid h-10 w-full cursor-pointer place-items-center rounded-xl text-white/40 transition hover:bg-white/[0.07] hover:text-white",
                    project.id === activeProjectId && "bg-white/[0.07] text-white/85",
                  )}
                >
                  <FolderIcon className="h-4 w-4" />
                </button>
              ))}
            </section>
          ) : (
            <button
              type="button"
              aria-label="Open project folder"
              title="Open project folder"
              onClick={onOpenProject}
              className="mb-4 grid h-10 w-full cursor-pointer place-items-center rounded-xl text-white/40 transition hover:bg-white/[0.07] hover:text-white"
            >
              <FolderIcon className="h-4 w-4" />
            </button>
          )}

          {open ? (
            <section>
              <h2 className="mb-2 px-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white/30">Tasks</h2>
              {groups.length > 0 ? (
                <div className="space-y-4">
                  {groups.map((group) => (
                    <section key={group.label}>
                      <h3 className="px-2 pb-1.5 text-[11px] font-medium text-white/35">{group.label}</h3>
                      <ul className="space-y-0.5">
                        {group.sessions.map((session) => (
                          <li key={session.title}>
                            <button
                              type="button"
                              onClick={() => runAndClose(() => onSelectSession(session))}
                              className="group/task w-full cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors duration-200 hover:bg-white/[0.07]"
                            >
                              <span className="flex items-center gap-2">
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/20 transition-colors duration-200 group-hover/task:bg-white/70" />
                                <span className="truncate text-[13px] font-medium text-white/75 group-hover/task:text-white">
                                  {session.title}
                                </span>
                              </span>
                              <span className="mt-0.5 block pl-3.5 text-[11px] text-white/30">{session.meta}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="px-2 py-2 text-[12px] text-white/35">No matching tasks.</p>
              )}
            </section>
          ) : sessions.length > 0 ? (
            <section aria-label="Tasks" className="space-y-1">
              {sessions.slice(0, 7).map((session) => (
                <button
                  key={session.title}
                  type="button"
                  aria-label={session.title}
                  title={session.title}
                  onClick={() => runAndClose(() => onSelectSession(session))}
                  className="grid h-9 w-full cursor-pointer place-items-center rounded-xl text-[11px] font-semibold text-white/35 transition hover:bg-white/[0.07] hover:text-white"
                >
                  {session.title.slice(0, 1).toUpperCase()}
                </button>
              ))}
            </section>
          ) : null}
        </nav>

        <div className="shrink-0 border-t border-white/[0.07] p-3">
          {open ? (
            <div className="flex items-center gap-2 rounded-xl px-2 py-2 text-white/45">
              <span className="h-1.5 w-1.5 rounded-full bg-white/50" />
              <span className="text-[11.5px]">Local workspace</span>
              <span className="ml-auto text-[10.5px] text-white/25">ready</span>
            </div>
          ) : (
            <div className="grid h-9 place-items-center text-[10px] font-bold tracking-[0.08em] text-white/30">K5</div>
          )}
        </div>
      </aside>
    </>
  );
}
