import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import { cn } from "@/utils/cn";

export type MenuItem = {
  id: string;
  label: string;
  meta?: string;
  icon?: ReactNode;
  role?: "menuitem" | "menuitemradio";
};

type MenuProps = {
  children: ReactNode;
  items: MenuItem[];
  value?: string;
  onSelect?: (id: string) => void;
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const getMenuButtons = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [],
    );

  const focusItem = (position: "first" | "last" | "selected") => {
    requestAnimationFrame(() => {
      const buttons = getMenuButtons();
      if (buttons.length === 0) {
        menuRef.current?.focus();
        return;
      }
      const selectedIndex = buttons.findIndex((button) => button.getAttribute("aria-checked") === "true");
      const index =
        position === "first"
          ? 0
          : position === "last"
            ? buttons.length - 1
            : Math.max(selectedIndex, 0);
      buttons[index]?.focus();
    });
  };

  const openMenu = (position: "first" | "last" | "selected" = "selected") => {
    setOpen(true);
    focusItem(position);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(true);
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

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu("selected");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu("last");
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [],
    );
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(currentIndex + 1) % buttons.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu();
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleTriggerKeyDown}
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

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          className={cn(
            "glass-menu animate-menu-in absolute z-50 max-h-[min(20rem,45vh)] w-max min-w-[15rem] overflow-y-auto rounded-[18px] p-1.5 thin-scroll",
            direction === "up" ? "bottom-full mb-3 origin-bottom" : "top-full mt-3 origin-top",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {items.map((item) => {
            const selected = item.id === value;
            const role = item.role ?? "menuitemradio";
            return (
              <button
                key={item.id}
                role={role}
                aria-checked={role === "menuitemradio" ? selected : undefined}
                tabIndex={-1}
                type="button"
                onClick={() => {
                  onSelect?.(item.id);
                  closeMenu(true);
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
                {selected && role === "menuitemradio" ? (
                  <CheckIcon className="h-4 w-4 shrink-0 text-ember-300" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
