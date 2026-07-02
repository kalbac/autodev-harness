import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
  /** Optional tone accent for the active underline (e.g. the Verdict tab). */
  accent?: string;
}

/**
 * Hand-rolled tablist (AO's approach — no headless dep). Controlled: the caller
 * owns `value` and renders the active panel. `role="tab"` + arrow semantics kept
 * minimal for a small, keyboard-reachable bar.
 */
export function TabBar({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex items-center gap-0.5 border-b border-line", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative px-3 py-2 text-xs font-medium transition-colors -mb-px border-b-2",
              active
                ? "text-text border-current"
                : "text-subtle border-transparent hover:text-muted",
            )}
            style={active && t.accent ? { color: t.accent } : undefined}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
