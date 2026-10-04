// Basic controls. Button and PaneHeader are adapted from Canopy
// (apps/web/src/components/ui at ea4f456, Apache-2.0; see NOTICE).
import clsx from "clsx";
import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from "react";

type Variant = "primary" | "danger" | "ghost" | "bare";
type Size = "xs" | "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-wb-accent text-neutral-950 hover:brightness-110 active:brightness-95",
  danger: "bg-red-700 text-white hover:bg-red-600 active:bg-red-800",
  ghost:
    "border border-wb-border bg-transparent text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100",
  bare: "text-neutral-400 hover:text-neutral-100",
};

// Touch-friendly heights: md is the minimum for primary mobile actions.
const SIZE: Record<Size, string> = {
  xs: "h-7 px-2 text-[12px]",
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
};

export function Button({
  variant = "ghost",
  size = "sm",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition disabled:pointer-events-none disabled:opacity-40",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
    />
  );
}

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={clsx(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100 disabled:opacity-40 md:h-8 md:w-8",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function PaneHeader({
  title,
  leading,
  children,
  className = "",
}: {
  title?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`flex h-11 shrink-0 items-center justify-between gap-2 border-b border-wb-border bg-wb-panel px-3 ${className}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        {title != null && (
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
            {title}
          </span>
        )}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </header>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Clicking the backdrop closes; Escape is handled natively by <dialog>.
      onClick={(e) => e.target === ref.current && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className={clsx(
        "m-auto w-[calc(100%-1.5rem)] rounded-lg border border-wb-border-strong bg-wb-panel p-0 text-neutral-200 shadow-2xl backdrop:bg-black/60",
        wide ? "max-w-2xl" : "max-w-md",
      )}
    >
      <div className="flex items-center justify-between border-b border-wb-border px-4 py-3">
        <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="max-h-[75dvh] overflow-y-auto p-4">{children}</div>
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children.
    <label className="block space-y-1.5">
      <span className="block text-[12px] font-medium text-neutral-300">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-neutral-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-wb-border-strong bg-wb-bg px-3 py-2 text-[15px] text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none md:text-sm";

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-[13px] text-red-300">
      {children}
    </p>
  );
}

/** Animated bars for "running"; static colored dot for other states. */
export function StatusIndicator({ state, className }: { state: string; className?: string }) {
  if (
    state === "running" ||
    state === "starting" ||
    state === "stopping" ||
    state === "setting_up" ||
    state === "creating"
  ) {
    return (
      <span className={clsx("inline-flex h-3 items-center gap-[2px]", className)} role="img" aria-label={state}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="wb-wave-bar h-3 w-[2px] rounded-full bg-wb-accent"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
    );
  }
  const color =
    state === "waiting_for_input"
      ? "bg-amber-400"
      : state === "failed" || state === "setup_failed" || state === "create_failed"
        ? "bg-red-500"
        : state === "interrupted"
          ? "bg-orange-400"
          : state === "queued"
            ? "bg-sky-400"
            : "bg-neutral-600";
  return <span className={clsx("inline-block h-2 w-2 rounded-full", color, className)} role="img" aria-label={state} />;
}

export function relativeTime(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
