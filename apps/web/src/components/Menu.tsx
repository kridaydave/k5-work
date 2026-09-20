import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import { cn } from "@/utils/cn";

export type MenuItem = {
  id: string;
  label: string;
  meta?: string;
  icon?: ReactNode;
};

type MenuProps = {
  children: ReactNode;
  items: MenuItem[];
  value?: string;
  onSelect?: (id: string) => void;
  /** which way the panel opens */
  direction?: "up" | "down";
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
  ariaLabel?: string;
};

export function Menu({
  children,
  items,
  value,
  onSelect,
  direction = "down",
  align = "left",
  className,
  panelClassName,
  ariaLabel,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
        className={cn("group/menu cursor-pointer text-left", className)}
      >
        {children}
        <ChevronDownIcon
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-current opacity-45 transition-transform duration-300 group-hover/menu:opacity-80",
            open && "rotate-180 opacity-80",
          )}
        />
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "glass-menu animate-menu-in absolute z-50 max-h-[min(20rem,45vh)] w-max min-w-[15rem] overflow-y-auto rounded-[18px] p-1.5 thin-scroll",
            direction === "up" ? "bottom-full mb-3 origin-bottom" : "top-full mt-3 origin-top",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {items.map((item) => {
            const selected = item.id === value;
            return (
              <button
                key={item.id}
                role="menuitemradio"
                aria-checked={selected}
                type="button"
                onClick={() => {
                  onSelect?.(item.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-200",
                  "hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none",
                  selected ? "text-white" : "text-white/75",
                )}
              >
                {item.icon ? <span className="text-white/55">{item.icon}</span> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] leading-5">{item.label}</span>
                  {item.meta ? (
                    <span className="mt-0.5 block truncate text-[11.5px] leading-4 text-white/40">{item.meta}</span>
                  ) : null}
                </span>
                {selected ? <CheckIcon className="h-4 w-4 shrink-0 text-ember-300" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
