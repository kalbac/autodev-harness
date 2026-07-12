import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ThreadEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ActivityCell } from "./ActivityCell";
import { PlanChip } from "./PlanChip";

/**
 * The live thread's mixed transcript -- prose bubbles, machine activity cells,
 * and plan chips, in the entries' persisted ts order (never re-sorted here).
 * Same `MessageScrollerProvider` / `MessageScroller` / `Viewport` / `Content` /
 * `Item` composition `ChatModal` used for its pre-launch preview, now the
 * full-thread version -- `ChatModal` is being deleted, so its local
 * `ChatBubble` helper is re-inlined here as `TranscriptBubble` rather than
 * imported.
 */
export function ThreadTranscript({
  projectId,
  entries,
  streamingText,
  onLaunchPlan,
  launching = false,
}: {
  projectId: string;
  entries: ThreadEntry[];
  streamingText: string;
  /** Wired by the next task (ThreadView) to `POST /threads/:id/confirm` --
   *  passed through to every `plan` entry's `PlanChip` (in practice a thread
   *  carries at most one live/current plan, so "every" and "the last one"
   *  coincide; passing to every chip is the simplest correct wiring). */
  onLaunchPlan?: () => void;
  launching?: boolean;
}) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="size-full min-h-0">
        <MessageScrollerViewport className="p-3">
          <MessageScrollerContent className="gap-3">
            {entries.map((entry, i) => (
              <MessageScrollerItem key={i} scrollAnchor={entry.type === "operator_msg"}>
                <ThreadEntryRow
                  projectId={projectId}
                  entry={entry}
                  onLaunchPlan={onLaunchPlan}
                  launching={launching}
                />
              </MessageScrollerItem>
            ))}
            {streamingText && (
              <MessageScrollerItem scrollAnchor>
                <TranscriptBubble role="assistant" text={streamingText} />
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function ThreadEntryRow({
  projectId,
  entry,
  onLaunchPlan,
  launching,
}: {
  projectId: string;
  entry: ThreadEntry;
  onLaunchPlan?: () => void;
  launching?: boolean;
}) {
  switch (entry.type) {
    case "operator_msg":
      return <TranscriptBubble role="operator" text={entry.text} />;
    case "orchestrator_msg":
      return (
        <div className="flex flex-col gap-1">
          <TranscriptBubble role="assistant" text={entry.text} />
          {entry.milestone && (
            <span className="ml-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {entry.milestone}
            </span>
          )}
        </div>
      );
    case "activity":
      return <ActivityCell projectId={projectId} entry={entry} />;
    case "plan":
      return <PlanChip specs={entry.specs} onLaunch={onLaunchPlan} launching={launching} />;
    case "run_link":
      return (
        <Link
          to="/p/$projectId/runs/$runId"
          params={{ projectId, runId: entry.runId }}
          className="flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-primary hover:underline"
        >
          <ArrowRight className="size-3" />
          run started — {entry.runId}
        </Link>
      );
    default:
      return null;
  }
}

/** Local operator/assistant bubble -- the same `Bubble`/`BubbleContent`
 *  composition `ChatModal`'s `ChatBubble` used: `default` variant + right
 *  align for the operator, `outline` variant + left align for the
 *  orchestrator. */
function TranscriptBubble({ role, text }: { role: "operator" | "assistant"; text: string }) {
  const isOperator = role === "operator";
  return (
    <div className={cn("flex", isOperator ? "justify-end" : "justify-start")}>
      <Bubble variant={isOperator ? "default" : "outline"} align={isOperator ? "end" : "start"}>
        <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
      </Bubble>
    </div>
  );
}
