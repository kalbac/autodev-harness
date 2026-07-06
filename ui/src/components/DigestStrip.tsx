import { useState } from "react";
import { ChevronRight, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";

/** The daemon's digest.md tail (last 50 lines) as a collapsible activity log.
 *  Read-only, global — the closest thing to a live run narration. */
export function DigestStrip({ digest }: { digest: string }) {
  const [open, setOpen] = useState(true);
  const lines = digest.split(/\r?\n/).filter((l) => l.length > 0);

  return (
    <div className="mx-auto max-w-3xl px-6 pb-8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-t border-line pt-4 text-left"
      >
        <ChevronRight className={cn("size-3.5 text-subtle transition-transform", open && "rotate-90")} />
        <ScrollText className="size-3.5 text-subtle" />
        <span className="font-mono text-[11px] uppercase tracking-wider text-subtle">
          Activity
        </span>
        <span className="font-mono text-[11px] text-subtle">{lines.length} lines</span>
      </button>

      {open &&
        (lines.length > 0 ? (
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-panel/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                {l}
              </div>
            ))}
          </pre>
        ) : (
          <p className="mt-2 px-1 font-mono text-[11px] text-subtle">No digest yet.</p>
        ))}
    </div>
  );
}
