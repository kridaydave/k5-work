import { ArrowLeftIcon, ArrowRightIcon, PanelLeftIcon, TrafficGlyph } from "@/components/icons";
import { cn } from "@/utils/cn";

type WindowChromeProps = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
};

function TrafficLight({
  color,
  glyph,
  label,
  onClick,
}: {
  color: string;
  glyph: "close" | "min" | "max";
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "group relative grid h-[13px] w-[13px] place-items-center rounded-full ring-1 transition duration-200",
        "hover:brightness-110 active:brightness-95",
        color,
      )}
    >
      <TrafficGlyph
        variant={glyph}
        className="h-[11px] w-[11px] scale-50 text-black/55 opacity-0 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100"
      />
    </button>
  );
}

function ChromeButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid h-[30px] w-[32px] cursor-pointer place-items-center rounded-[9px] transition duration-200",
        disabled ? "text-white/25" : "text-white/55 hover:bg-white/[0.09] hover:text-white active:scale-95",
      )}
    >
      {children}
    </button>
  );
}

export function WindowChrome({ sidebarOpen, onToggleSidebar }: WindowChromeProps) {
  return (
    <header className="animate-fade-in absolute inset-x-0 top-0 z-40 flex justify-start p-3.5 sm:p-4">
      <div className="glass-chrome flex items-center gap-1.5 rounded-[15px] px-3 py-[7px]">
        <div className="flex items-center gap-[8px] pr-1.5">
          <TrafficLight color="bg-[#ff5f57] ring-black/20" glyph="close" label="Close window" />
          <TrafficLight color="bg-[#febc2e] ring-black/20" glyph="min" label="Minimize window" />
          <TrafficLight color="bg-[#28c840] ring-black/20" glyph="max" label="Zoom window" />
        </div>

        <div className="mx-0.5 flex items-center gap-0.5">
          <ChromeButton label="Toggle sidebar" onClick={onToggleSidebar}>
            <PanelLeftIcon
              className={cn(
                "h-[17px] w-[17px] transition-colors",
                sidebarOpen && "text-ember-200",
              )}
            />
          </ChromeButton>
          <ChromeButton label="Back" disabled>
            <ArrowLeftIcon className="h-[17px] w-[17px]" />
          </ChromeButton>
          <ChromeButton label="Forward" disabled>
            <ArrowRightIcon className="h-[17px] w-[17px]" />
          </ChromeButton>
        </div>
      </div>
    </header>
  );
}
