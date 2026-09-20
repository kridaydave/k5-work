import { useState } from "react";
import { Menu, type MenuItem } from "@/components/Menu";
import { BranchIcon, DisplayIcon } from "@/components/icons";

const CHECKOUTS: MenuItem[] = [
  { id: "checkout", label: "checkout", meta: "~/dev/cowork" },
  { id: "fork", label: "fork", meta: "~/dev/cowork-fork" },
  { id: "sandbox", label: "sandbox", meta: "~/dev/sandbox" },
];

const BRANCHES: MenuItem[] = [
  { id: "main", label: "main", meta: "up to date with origin" },
  { id: "feat/composer", label: "feat/composer", meta: "2 ahead · 1 behind" },
  { id: "release/5.1", label: "release/5.1", meta: "protected" },
];

const DEVICES: MenuItem[] = [
  { id: "macbook", label: "Arman’s MacBook Pro", meta: "Connected · macOS 15.4" },
  { id: "studio", label: "Arman’s Mac Studio", meta: "Available on local network" },
  { id: "add", label: "Add a computer…" },
];

export function BottomDock() {
  const [checkout, setCheckout] = useState("checkout");
  const [branch, setBranch] = useState("main");
  const [device, setDevice] = useState("macbook");

  const pillClass =
    "flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.045] px-2.5 py-[5px] text-[12.5px] font-medium text-white/60 transition-all duration-200 hover:border-white/[0.16] hover:bg-white/[0.09] hover:text-white";

  return (
    <footer className="relative z-20 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-8 sm:pb-5">
      {/* soft fade so text stays legible over the artwork */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-44 bg-[linear-gradient(to_top,rgba(5,7,10,0.94)_12%,rgba(5,7,10,0.55)_55%,transparent)]" />

      <div className="mx-auto flex w-full max-w-[1500px] flex-col items-start gap-3.5 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="animate-fade-up min-w-0" style={{ animationDelay: "340ms" }}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="font-serif text-[17px] font-semibold tracking-[-0.012em] text-white/95">Fable 5.1</h2>
            <p className="text-[12px] font-medium tracking-[0.01em] text-white/40">true · 300K · Low</p>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Menu
              ariaLabel="Choose checkout"
              items={CHECKOUTS}
              value={checkout}
              onSelect={setCheckout}
              direction="up"
              className={pillClass}
            >
              <span className="max-w-[10rem] truncate">
                {CHECKOUTS.find((c) => c.id === checkout)?.label ?? "checkout"}
              </span>
            </Menu>

            <Menu
              ariaLabel="Choose branch"
              items={BRANCHES}
              value={branch}
              onSelect={setBranch}
              direction="up"
              className={pillClass}
            >
              <BranchIcon className="h-[14px] w-[14px] opacity-75" />
              <span className="max-w-[10rem] truncate">
                {BRANCHES.find((b) => b.id === branch)?.label ?? "main"}
              </span>
            </Menu>
          </div>
        </div>

        <div className="animate-fade-up" style={{ animationDelay: "420ms" }}>
          <Menu
            ariaLabel="Choose computer"
            items={DEVICES}
            value={device}
            onSelect={setDevice}
            direction="up"
            align="right"
            className="flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-2 text-[14.5px] font-medium text-white/70 transition-colors duration-200 hover:bg-white/[0.07] hover:text-white"
          >
            <DisplayIcon className="h-[18px] w-[18px] opacity-75" />
            <span className="max-w-[58vw] truncate sm:max-w-none">
              {DEVICES.find((d) => d.id === device)?.label ?? "Arman’s MacBook Pro"}
            </span>
          </Menu>
        </div>
      </div>
    </footer>
  );
}
