import type { ReactNode } from "react";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";

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
      <div className="flex items-center gap-3 border-b border-border px-4 h-14">
        {back}
        <span className="font-sans text-[15px] font-semibold text-foreground">{title}</span>
        {subtitle && <span className="font-mono text-[11px] text-muted-foreground">{subtitle}</span>}
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
    <Card>
      <CardHeader className="flex items-center gap-2 py-2.5">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
        {aside && <div className="ml-auto">{aside}</div>}
      </CardHeader>
      <CardBody className={className}>{children}</CardBody>
    </Card>
  );
}

/** One key/value line: muted label left, mono value right. `value` falls back to
 *  an em-dash when empty so a loading/absent field never renders blank. */
export function SettingsRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1.5">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-[11px] text-foreground">
        {value === "" || value === null || value === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          value
        )}
      </span>
    </div>
  );
}
