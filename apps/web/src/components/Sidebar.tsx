import { CloseIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { Reveal } from "@/components/Reveal";
import { cn } from "@/utils/cn";

type Session = { title: string; meta: string };

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
  onClose: () => void;
};

export function Sidebar({ open, onClose }: SidebarProps) {
  return (
    <>
      {/* scrim */}
      <div
        onClick={onClose}
        aria-hidden={!open}
        className={cn(
          "absolute inset-0 z-30 bg-black/45 backdrop-blur-[3px] transition-opacity duration-500",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        aria-label="Session history"
        aria-hidden={!open}
        className={cn(
          "glass-panel absolute inset-y-0 left-0 z-40 flex w-[86vw] max-w-[300px] flex-col rounded-l-none transition-transform duration-[600ms] [transition-timing-function:cubic-bezier(0.16,0.84,0.28,1)] lg:rounded-l-[26px]",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-[4.4rem]">
          <h2 className="font-serif text-[18px] font-semibold tracking-[-0.01em] text-white/95">Cowork</h2>
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={onClose}
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-full text-white/45 transition duration-200 hover:bg-white/[0.09] hover:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 px-4">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.05] px-3 py-2 text-[13.5px] font-medium text-white/85 transition duration-200 hover:border-white/20 hover:bg-white/[0.1] active:scale-[0.99]"
          >
            <PlusIcon className="h-4 w-4 text-white/70" />
            New task
          </button>

          <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.035] px-3 py-2 transition-colors duration-200 focus-within:border-white/20">
            <SearchIcon className="h-4 w-4 shrink-0 text-white/40" />
            <input
              type="search"
              placeholder="Search sessions"
              className="w-full bg-transparent text-[13.5px] text-white/90 placeholder:text-white/35 focus:outline-none"
            />
          </div>
        </div>

        <nav className="thin-scroll mt-5 flex-1 overflow-y-auto px-2.5 pb-6">
          {GROUPS.map((group) => (
            <section key={group.label} className="mb-5">
              <h3 className="px-2.5 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">
                {group.label}
              </h3>
              <ul className="space-y-0.5">
                {group.sessions.map((session, index) => (
                  <Reveal key={session.title} as="li" delay={index * 70}>
                    <button
                      type="button"
                      className={cn(
                        "group/item w-full cursor-pointer rounded-xl px-2.5 py-2 text-left transition-colors duration-200",
                        "hover:bg-white/[0.07]",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/20 transition-colors duration-300 group-hover/item:bg-ember-300" />
                        <span className="truncate text-[13.5px] font-medium text-white/80 group-hover/item:text-white">
                          {session.title}
                        </span>
                      </span>
                      <span className="mt-0.5 block pl-3.5 text-[11.5px] text-white/35">{session.meta}</span>
                    </button>
                  </Reveal>
                ))}
              </ul>
            </section>
          ))}
        </nav>

        <div className="flex items-center gap-3 border-t border-white/[0.07] px-5 py-4">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[linear-gradient(140deg,#ffb98a,#dd5c3a_60%,#7b2f1d)] text-[13px] font-semibold text-black/70">
            A
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium text-white/85">Arman</span>
            <span className="block truncate text-[11.5px] text-white/35">Max plan · 5 seats</span>
          </span>
        </div>
      </aside>
    </>
  );
}
