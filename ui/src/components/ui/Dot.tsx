import { cn } from "@/lib/utils";
import { toneVar, type Tone } from "@/lib/status";

/** A 7px status dot in one tone. `pulse` adds the working heartbeat. */
export function Dot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span
      className={cn("inline-block size-[7px] shrink-0 rounded-full", className)}
      style={{
        background: toneVar[tone],
        animation: pulse ? "status-pulse 1.8s ease-in-out infinite" : undefined,
      }}
    />
  );
}
