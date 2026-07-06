import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared chrome for the two settings screens (Global + Project). A settings
 * screen is a full-main configuration surface: a top bar (back + title) and a
 * centered, readable scroll column of sections. Deliberately calm — no color
 * unless a value carries a status tone.
 */
export function SettingsPage({
  title,
  subtitle,
  back,
  children,
}: {
  title: string;
  subtitle?: string;
  back?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 h-14">
        {back}
        <span className="font-sans text-[15px] font-semibold text-text">{title}</span>
        {subtitle && <span className="font-mono text-[11px] text-subtle">{subtitle}</span>}
      </div>
      <div className="flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8">{children}</div>
      </div>
    </div>
  );
}

/** A titled card. `title` is the mono-uppercase section label; `aside` sits at
 *  the far right of the header (e.g. a count or a control). */
export function SettingsSection({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-subtle">{title}</h2>
        {aside && <div className="ml-auto">{aside}</div>}
      </header>
      <div className={cn("px-4 py-3", className)}>{children}</div>
    </section>
  );
}

/** One key/value line: muted label left, mono value right. `value` falls back to
 *  an em-dash when empty so a loading/absent field never renders blank. */
export function SettingsRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1.5">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-[11px] text-text">
        {value === "" || value === null || value === undefined ? (
          <span className="text-subtle">—</span>
        ) : (
          value
        )}
      </span>
    </div>
  );
}
