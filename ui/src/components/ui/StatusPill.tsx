import { cn } from "@/lib/utils";
import { toneVar, type Tone } from "@/lib/status";
import { Dot } from "./Dot";

/**
 * A tinted bordered pill built from ONE tone via color-mix — feed it a tone and
 * a label and it themes itself (AO's status-pill technique). The one shared
 * status primitive across board, sidebar, and inspector.
 */
export function StatusPill({
  tone,
  label,
  pulse = false,
  className,
}: {
  tone: Tone;
  label: string;
  pulse?: boolean;
  className?: string;
}) {
  const c = toneVar[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide leading-none",
        className,
      )}
      style={{
        color: c,
        background: `color-mix(in srgb, ${c} 9%, transparent)`,
        borderColor: `color-mix(in srgb, ${c} 30%, transparent)`,
      }}
    >
      <Dot tone={tone} pulse={pulse} />
      {label}
    </span>
  );
}
