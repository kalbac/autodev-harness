import { ArrowUp } from "lucide-react";
import type { PlanSpecPreview } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Feedback";

/**
 * The "Proposed plan — preview only" block, ported from `ChatModal`'s
 * pre-launch plan preview so the live thread transcript renders the same
 * plan shape. FIXES the s38 polish bug (#2) the modal shipped with: there the
 * outer flex-wrap container could still force the dialog wider than the
 * viewport when a spec title had no natural break point (a long
 * hyphen-free/slash-free identifier). Here the container is `max-w-full` and
 * every badge truncates with `whitespace-normal break-words` PLUS a hard
 * `max-w-full` of its own, so long titles wrap or clip inside the badge
 * instead of stretching the transcript.
 */
export function PlanChip({
  specs,
  onLaunch,
  launching = false,
}: {
  specs: PlanSpecPreview[];
  onLaunch?: () => void;
  launching?: boolean;
}) {
  return (
    <div className="flex max-w-full flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
      <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        Proposed plan — preview only
      </span>
      <div className="flex max-w-full flex-wrap gap-1.5">
        {specs.map((s) => (
          <Badge
            key={s.id}
            variant="outline"
            className="h-auto max-w-full whitespace-normal break-words text-left font-mono text-[11px] font-normal"
            title={`${s.title} · ${s.type}`}
          >
            {s.title} <span className="text-muted-foreground">· {s.type}</span>
          </Badge>
        ))}
      </div>
      {onLaunch && (
        <Button
          onClick={onLaunch}
          disabled={launching}
          variant="primary"
          size="sm"
          className="mt-1 self-start"
        >
          {launching ? <Spinner className="text-primary-foreground" /> : <ArrowUp className="size-3.5" />}
          Launch
        </Button>
      )}
    </div>
  );
}
