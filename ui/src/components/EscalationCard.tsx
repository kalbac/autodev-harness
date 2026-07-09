import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, GitCommitHorizontal, Inbox } from "lucide-react";
import { api } from "@/lib/api";
import { qk, useEscalation } from "@/lib/queries";
import { verdictTone, toneVar } from "@/lib/status";
import { StatusPill } from "./ui/StatusPill";
import { Badge } from "./ui/badge";
import { Card } from "./ui/Card";
import { Textarea } from "./ui/textarea";
import { EmptyState, Loading } from "./ui/Feedback";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/**
 * The A/B decision surface — this IS "never merge bullshit" in the moment the
 * gate refused. It shows exactly what the operator is deciding (question, both
 * options, evidence, cost of a wrong call) and records a structured A/B choice.
 * `note` is context-only and is NEVER executed as a worker instruction.
 */
export function EscalationCard({ projectId, taskId }: { projectId: string; taskId: string }) {
  const esc = useEscalation(projectId, taskId);
  const [note, setNote] = useState("");
  const [confirmC, setConfirmC] = useState(false);
  const qc = useQueryClient();

  const reply = useMutation({
    mutationFn: (choice: "A" | "B" | "C") => api.postReply(projectId, taskId, choice, note),
    onSuccess: () => {
      setConfirmC(false);
      void qc.invalidateQueries({ queryKey: qk.escalation(projectId, taskId) });
      void qc.invalidateQueries({ queryKey: qk.state(projectId) });
    },
  });

  if (esc.isLoading) return <Loading label="Loading escalation…" />;
  if (esc.isError) {
    return (
      <EmptyState icon={Inbox} title="No escalation record for this task." />
    );
  }

  const e = esc.data!;
  const tone = e.type === "disagreement" ? "broken" : "uncertain";
  const alreadyReplied = e.reply !== null;

  return (
    <Card
      className="rounded-xl bg-card p-5"
      style={{ borderColor: `color-mix(in srgb, ${toneVar[tone]} 35%, transparent)` }}
    >
      <div className="flex items-center gap-2 mb-3">
        <ShieldAlert className="size-4" style={{ color: toneVar[tone] }} />
        <span className="font-sans text-sm font-semibold text-foreground">The gate needs you</span>
        <StatusPill tone={verdictTone(e.type === "disagreement" ? "broken" : "uncertain")} label={e.type} className="ml-1" />
        <Badge variant="outline" className="ml-auto font-mono text-[11px] normal-case tracking-normal text-muted-foreground">
          {e.reason}
        </Badge>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm mb-4">
        <dt className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground pt-0.5">What</dt>
        <dd className="text-muted-foreground">{e.what}</dd>
        <dt className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground pt-0.5">Decide</dt>
        <dd className="text-foreground">{e.decision}</dd>
        <dt className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground pt-0.5">Cost</dt>
        <dd className="text-muted-foreground">{e.costOfWrong}</dd>
      </dl>

      {e.evidence.trim().length > 0 && (
        <pre className="mb-4 max-h-48 overflow-auto rounded-lg border border-border bg-muted/60 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
          {e.evidence}
        </pre>
      )}

      {alreadyReplied ? (
        <div
          className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm"
          style={{
            borderColor: `color-mix(in srgb, ${toneVar.clean} 35%, transparent)`,
            color: toneVar.clean,
          }}
        >
          <CheckCircle2 className="size-4" />
          Replied <span className="font-mono font-semibold">{e.reply!.choice}</span>
          {e.reply!.choice === "C" && e.reply!.commit && (
            <span className="text-muted-foreground">
              — committed <span className="font-mono">{e.reply!.commit.slice(0, 8)}</span>
            </span>
          )}
          {e.reply!.note && <span className="text-muted-foreground">— {e.reply!.note}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Textarea
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            placeholder="Optional note — recorded for context only, NEVER executed as an instruction."
            rows={2}
            className="resize-none bg-muted/60"
          />
          <div className="grid grid-cols-2 gap-3">
            <OptionButton
              letter="A"
              text={e.optionA}
              disabled={reply.isPending}
              onClick={() => reply.mutate("A")}
            />
            <OptionButton
              letter="B"
              text={e.optionB}
              disabled={reply.isPending}
              onClick={() => reply.mutate("B")}
            />
          </div>

          {/* Gate OVERRIDE — commits the reviewed diff the critic did NOT bless.
              Deliberately separate from A/B and gated behind a confirmation. */}
          <button
            onClick={() => setConfirmC(true)}
            disabled={reply.isPending}
            className="flex items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2 text-[13px] font-medium transition-colors hover:bg-muted disabled:opacity-50"
            style={{
              borderColor: `color-mix(in srgb, ${toneVar.broken} 45%, transparent)`,
              color: toneVar.broken,
            }}
          >
            <GitCommitHorizontal className="size-4" />
            Commit anyway — override the gate
          </button>

          {reply.isError && (
            <p className="text-xs text-broken">Could not record reply: {(reply.error as Error).message}</p>
          )}
        </div>
      )}

      <Dialog open={confirmC} onOpenChange={(o) => !reply.isPending && setConfirmC(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4" style={{ color: toneVar.broken }} />
              Commit over the critic&apos;s objection?
            </DialogTitle>
            <DialogDescription>
              This commits the worker&apos;s reviewed change to the loop branch even though the
              independent critic did <span className="font-semibold text-foreground">not</span> bless it.
              It is a deliberate human override of the gate — the change becomes part of the repo and
              satisfies any dependent task. It only applies if the diff still cleanly applies; otherwise
              it is refused and the task stays escalated.
            </DialogDescription>
          </DialogHeader>
          {reply.isError && (
            <p className="rounded-md border border-broken/40 bg-muted/60 px-3 py-2 text-xs text-broken">
              Refused: {(reply.error as Error).message}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmC(false)} disabled={reply.isPending}>
              Cancel
            </Button>
            <button
              onClick={() => reply.mutate("C")}
              disabled={reply.isPending}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium text-primary-foreground transition-colors disabled:opacity-50"
              style={{ backgroundColor: toneVar.broken }}
            >
              <GitCommitHorizontal className="size-4" />
              {reply.isPending ? "Committing…" : "Commit anyway"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function OptionButton({
  letter,
  text,
  disabled,
  onClick,
}: {
  letter: "A" | "B";
  text: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-muted font-mono text-xs font-semibold text-foreground">
        {letter}
      </span>
      <span className="text-[13px] leading-snug text-muted-foreground">{text}</span>
    </button>
  );
}
