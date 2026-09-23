import { PanelLeftIcon } from "@/components/icons";
import { cn } from "@/utils/cn";

type WindowChromeProps = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
};

export function WindowChrome({ sidebarOpen, onToggleSidebar }: WindowChromeProps) {
  return (
    <header className="animate-fade-in absolute inset-x-0 top-0 z-40 flex justify-start p-3.5 sm:p-4">
      <button
        type="button"
        aria-label="Toggle sidebar"
        aria-pressed={sidebarOpen}
        title="Toggle sidebar (Ctrl+B)"
        onClick={onToggleSidebar}
        className={cn(
          "glass-chrome flex h-[36px] w-[40px] cursor-pointer items-center justify-center rounded-[13px] text-white/60 transition duration-200",
          "hover:text-white active:scale-95",
        )}
      >
        <PanelLeftIcon
          className={cn(
            "h-[17px] w-[17px] transition-colors",
            sidebarOpen && "text-ember-200",
          )}
        />
      </button>
    </header>
  );
}
