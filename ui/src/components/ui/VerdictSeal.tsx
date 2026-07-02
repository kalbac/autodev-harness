import { cn } from "@/lib/utils";
import { toneVar, verdictTone } from "@/lib/status";

export interface BrokenContract {
  zone: string;
  file: string;
  line: number;
  evidence: string;
}

/**
 * THE SIGNATURE ELEMENT — the critic verdict rendered as a checkpoint seal.
 * This is the "never merge bullshit" thesis made visible: an inset-ringed mono
 * stamp in the verdict's tone. Everything else on the page stays quiet so this
 * reads first. `compact` is the card-sized chip; full mode adds confidence +
 * notes + broken-contract evidence.
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
  const c = toneVar[verdictTone(verdict)];

  const stamp = (
    <div
      className={cn(
        "inline-flex flex-col items-center justify-center rounded-md font-mono uppercase",
        compact ? "px-2.5 py-1" : "px-5 py-3",
      )}
      style={{
        color: c,
        background: `color-mix(in srgb, ${c} 8%, transparent)`,
        borderColor: `color-mix(in srgb, ${c} 45%, transparent)`,
        borderWidth: 1,
        borderStyle: "solid",
        boxShadow: `inset 0 0 0 3px color-mix(in srgb, ${c} 12%, transparent)`,
      }}
    >
      {!compact && (
        <span className="text-[9px] tracking-[0.32em] opacity-70">critic verdict</span>
      )}
      <span
        className={cn(
          "font-semibold tracking-[0.18em]",
          compact ? "text-xs" : "text-2xl mt-0.5",
        )}
      >
        {verdict}
      </span>
    </div>
  );

  if (compact) return <span className={className}>{stamp}</span>;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-4">
        {stamp}
        {typeof confidence === "number" && (
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-[11px] text-muted mb-1">
              <span className="font-mono uppercase tracking-wide">confidence</span>
              <span className="font-mono tabular-nums" style={{ color: c }}>
                {confidence.toFixed(2)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.round(confidence * 100)}%`, background: c }}
              />
            </div>
          </div>
        )}
      </div>

      {notes && (
        <p className="text-sm text-muted leading-relaxed whitespace-pre-wrap break-words">{notes}</p>
      )}

      {brokenContracts && brokenContracts.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {brokenContracts.map((bc, i) => (
            <li
              key={i}
              className="rounded-md border border-line bg-surface-2/60 px-3 py-2 font-mono text-xs"
            >
              <div className="flex items-center gap-2 text-broken">
                <span className="uppercase tracking-wide">{bc.zone}</span>
                <span className="text-subtle">
                  {bc.file}:{bc.line}
                </span>
              </div>
              <div className="text-muted mt-1 whitespace-pre-wrap break-words">{bc.evidence}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
