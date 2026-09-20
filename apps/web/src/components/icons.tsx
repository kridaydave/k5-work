import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M21.2 11.3l-8.6 8.6a5.4 5.4 0 0 1-7.6-7.6l8.5-8.5a3.6 3.6 0 0 1 5.1 5.1l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8" />
    </Base>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 7.6A2.6 2.6 0 0 1 5.6 5h3.1c.7 0 1.4.3 1.9.9l.8 1h7A2.6 2.6 0 0 1 21 9.5v7A2.6 2.6 0 0 1 18.4 19H5.6A2.6 2.6 0 0 1 3 16.4V7.6Z" />
    </Base>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Base>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Base strokeWidth={1.9} {...props}>
      <path d="M12 19.5V5" />
      <path d="m5.5 11.5 6.5-6.5 6.5 6.5" />
    </Base>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M19.5 12H5" />
      <path d="m11 5.5-6.5 6.5L11 18.5" />
    </Base>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 12H19" />
      <path d="m13 5.5 6.5 6.5L13 18.5" />
    </Base>
  );
}

export function PanelLeftIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3.25" y="4.25" width="17.5" height="15.5" rx="3" />
      <path d="M9.75 4.25v15.5" />
    </Base>
  );
}

export function DisplayIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.75" y="3.75" width="18.5" height="12.5" rx="2.5" />
      <path d="M9 20.25h6" />
      <path d="M12 16.5v3.75" />
    </Base>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6.5 3.75v9.75" />
      <circle cx="6.5" cy="17.75" r="2.75" />
      <circle cx="17.5" cy="6.25" r="2.75" />
      <path d="M17.5 9c0 4.5-4.6 5-8 5.8" />
    </Base>
  );
}

export function CubeIcon(props: IconProps) {
  return (
    <Base strokeWidth={1.5} {...props}>
      <path d="M12 2.7 20.6 7.4v9.2L12 21.3 3.4 16.6V7.4L12 2.7Z" />
      <path d="M3.6 7.5 12 12.1l8.4-4.6" />
      <path d="M12 12.1v9" />
    </Base>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </Base>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </Base>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </Base>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Base>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.5V12l3 1.8" />
    </Base>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7L12 3.5Z" />
      <path d="M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z" />
    </Base>
  );
}

/** Filled macOS-style traffic light glyph (used for the window buttons). */
export function TrafficGlyph({ variant, className }: { variant: "close" | "min" | "max"; className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
      {variant === "close" && <path d="M3.9 3.9l4.2 4.2M8.1 3.9L3.9 8.1" />}
      {variant === "min" && <path d="M3.2 6h5.6" />}
      {variant === "max" && (
        <path d="M4.2 3.6h3.1c.6 0 1.1.5 1.1 1.1v3.1" />
      )}
    </svg>
  );
}
