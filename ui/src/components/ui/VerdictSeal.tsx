import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@/lib/utils";
import { toneVar, verdictTone } from "@/lib/status";
import { Badge } from "./badge";
import { ProgressIndicator, ProgressTrack } from "./progress";

export interface BrokenContract {
  zone: string;
  file: string;
  line: number;
  evidence: string;
}

/**
 * The critic verdict — a shadcn `Badge` composition tinted by verdict tone
 * (the same color-mix-on-a-Badge technique as `StatusPill`, so "broken" reads
 * as the same red everywhere — DiffView's del lines, EscalationCard's border —
 * rather than introducing shadcn's separate `destructive` red as a second
 * broken color). `compact` is the card-sized badge alone; full mode adds a
 * confidence bar, notes, and broken-contract evidence rows.
 */
export function VerdictSeal({
  verdict,
  confidence,
  notes,
  brokenContracts,
  compact = false,
  className,
}: {
  verdict: "clean" | "broken" | "uncertain";
  confidence?: number;
  notes?: string;
  brokenContracts?: BrokenContract[];
  compact?: boolean;
  className?: string;
}) {
  const tone = verdictTone(verdict);
  const c = toneVar[tone];

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full font-mono uppercase tracking-[0.14em]",
        compact ? "text-[11px]" : "px-3 py-1 text-sm",
      )}
      style={{
        color: c,
        background: `color-mix(in srgb, ${c} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${c} 40%, transparent)`,
      }}
    >
      {verdict}
    </Badge>
  );

  if (compact) return <span className={className}>{badge}</span>;

  const pct = typeof confidence === "number" ? Math.round(confidence * 100) : null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
          critic verdict
        </span>
        {badge}
      </div>

      {pct !== null && (
        <div className="max-w-xs">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-mono uppercase tracking-wide">confidence</span>
            <span className="font-mono tabular-nums" style={{ color: c }}>
              {confidence!.toFixed(2)}
            </span>
          </div>
          <ProgressPrimitive.Root value={pct}>
            <ProgressTrack className="h-1.5">
              <ProgressIndicator style={{ background: c }} />
            </ProgressTrack>
          </ProgressPrimitive.Root>
        </div>
      )}

      {notes && (
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">{notes}</p>
      )}

      {brokenContracts && brokenContracts.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {brokenContracts.map((bc, i) => (
            <li
              key={i}
              className="rounded-md border bg-muted px-3 py-2 font-mono text-xs"
              style={{ borderColor: `color-mix(in srgb, ${toneVar.broken} 35%, transparent)` }}
            >
              <div className="flex items-center gap-2" style={{ color: toneVar.broken }}>
                <span className="uppercase tracking-wide">{bc.zone}</span>
                <span className="text-muted-foreground">
                  {bc.file}:{bc.line}
                </span>
              </div>
              <div className="text-muted-foreground mt-1 whitespace-pre-wrap break-words">{bc.evidence}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
