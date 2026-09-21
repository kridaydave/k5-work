import { PanelLeftIcon } from "@/components/icons";
import { cn } from "@/utils/cn";

type WindowChromeProps = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
};

function ChromeButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-[30px] w-[32px] cursor-pointer place-items-center rounded-[9px] transition duration-200",
        "text-white/55 hover:bg-white/[0.09] hover:text-white active:scale-95",
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
        <div className="mx-0.5 flex items-center gap-0.5">
          <ChromeButton label="Toggle sidebar" onClick={onToggleSidebar}>
            <PanelLeftIcon
              className={cn(
                "h-[17px] w-[17px] transition-colors",
                sidebarOpen && "text-ember-200",
              )}
            />
          </ChromeButton>
        </div>
      </div>
    </header>
  );
}
