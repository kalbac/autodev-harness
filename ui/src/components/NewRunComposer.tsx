import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { useConfig, useProjects, useState as useProjectState } from "@/lib/queries";
import { useAppStore } from "@/lib/store";
import { useProjectId } from "@/lib/useProjectId";
import { ChatModal } from "./ChatModal";
import { ProjectSwitcherMenu } from "./ProjectSwitcherMenu";
import { Badge } from "./ui/badge";
import { Button } from "./ui/Button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "./ui/input-group";
import { Kbd, KbdGroup } from "./ui/kbd";

/** Only watch for this long after a launch: the orchestrator's own early outcome
 *  lines (0-task / relaunch dedup / validation reject) land within a couple of
 *  WS-invalidate cycles; a plain enqueue+drain can run far longer, in which case
 *  the existing "Recent runs" / sidebar surfaces already show something new, so
 *  there is nothing silent left to explain. */
const DIGEST_WATCH_MS = 20_000;

/** Split one digest.md line of the form `[orchestrator] [LEVEL] message` into its
 *  level + a human message (drops the also-redundant leading "orchestrator: "). */
function parseOrchestratorDigestLine(line: string): { level: string; message: string } | null {
  const m = /^\[orchestrator\] \[(\w+)\] (?:orchestrator: )?(.*)$/.exec(line);
  if (!m) return null;
  return { level: m[1]!, message: m[2]! };
}

/**
 * The "new run" intent box — the one write surface that launches work. The
 * textarea's "Launch run" no longer POSTs /orchestrate directly: it opens a
 * `ChatModal` with the typed text as the first turn, and only a successful
 * "Confirm & Launch" inside that modal actually enqueues+triggers, through the
 * same validated orchestrator path the CLI uses (R1-safe server-side); it
 * cannot run/skip/reorder any gate step.
 */
export function NewRunComposer({ autoFocus = false }: { autoFocus?: boolean }) {
  // Rendered on the project home; the route guarantees projectId (`?? ""` for the type).
  const projectId = useProjectId() ?? "";
  const [intent, setIntent] = useState("");
  // "Re-run" seed from RunView: pre-fill the box once, then clear the store so a
  // later manual edit / navigation doesn't get clobbered.
  const composerSeed = useAppStore((s) => s.composerSeed);
  const clearComposerSeed = useAppStore((s) => s.clearComposerSeed);
  useEffect(() => {
    if (composerSeed !== null) {
      setIntent(composerSeed);
      clearComposerSeed();
    }
  }, [composerSeed, clearComposerSeed]);
  const projects = useProjects();
  const config = useConfig(projectId);
  const projectState = useProjectState(projectId);

  const projectName = projects.data?.projects.find((p) => p.id === projectId)?.name ?? projectId;
  const cfg = config.data;
  const workerModel = cfg?.roles.worker.ladder[0] ?? "—";
  const criticModel = cfg ? `${cfg.roles.critic.model} · ${cfg.roles.critic.effort}` : "—";

  // Surfaces the orchestrator's own real outcome for THIS launch — a relaunch
  // dedup skip, a 0-task decomposition, or a rejected batch previously looked
  // like a silent no-op (the composer only ever showed a static "accepted"
  // message; see gotcha [ui/orchestrate-silent-dedup]). `digestTail` is already
  // WS-live (any digest.md write re-triggers this query), so we just watch it:
  // capture how many `[orchestrator]`-prefixed lines exist at launch time, then
  // toast the first NEW one that appears (its own report() call, whatever the
  // outcome was), once, within a bounded window. This arming needs to fire from
  // BOTH a real launch's trigger points — today that's only `ChatModal`'s
  // Confirm & Launch (the plain direct-POST path this replaced is gone), but
  // the arming logic itself stays local to this component since it owns the
  // watch and the toast.
  const watchRef = useRef<{ baseline: number; deadline: number } | null>(null);
  useEffect(() => {
    const watch = watchRef.current;
    const digest = projectState.data?.digestTail;
    if (!watch || digest === undefined) return;
    if (Date.now() > watch.deadline) {
      watchRef.current = null;
      return;
    }
    const orchLines = digest.split(/\r?\n/).filter((l) => l.startsWith("[orchestrator] "));
    if (orchLines.length <= watch.baseline) return;
    // The FIRST new line after the launch — not the latest overall — in case
    // several orchestrator lines land between one digestTail refetch and the
    // next (codex finding): the operator wants THIS launch's own outcome, not
    // whatever is newest by the time the toast fires.
    const parsed = parseOrchestratorDigestLine(orchLines[watch.baseline]!);
    if (parsed) {
      if (parsed.level === "WARN") toast.warning(parsed.message);
      else if (parsed.level === "ERROR") toast.error(parsed.message);
      else toast.info(parsed.message);
    }
    watchRef.current = null; // one toast per launch
  }, [projectState.data?.digestTail]);

  const armDigestWatch = useCallback(() => {
    const baseline = (projectState.data?.digestTail ?? "")
      .split(/\r?\n/)
      .filter((l) => l.startsWith("[orchestrator] ")).length;
    watchRef.current = { baseline, deadline: Date.now() + DIGEST_WATCH_MS };
  }, [projectState.data?.digestTail]);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatIntent, setChatIntent] = useState("");

  const trimmed = intent.trim();
  const canSubmit = trimmed.length > 0;

  const submit = () => {
    if (!canSubmit || chatOpen) return;
    setChatIntent(trimmed);
    setChatOpen(true);
    setIntent("");
  };

  return (
    <div className="flex flex-col gap-2">
      <InputGroup className="rounded-xl border-border bg-card focus-within:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-0">
        <InputGroupTextarea
          autoFocus={autoFocus}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          placeholder="Describe a change to make — the orchestrator decomposes it into gated tasks…"
          rows={3}
          className="px-4 pt-3.5 text-sm outline-none"
        />
        <InputGroupAddon align="block-end" className="flex-wrap px-3 pb-3 pt-0">
          <ProjectSwitcherMenu projectId={projectId} projectName={projectName} />
          {/* Roles are read-only; clicking opens project settings. Badge (not
              Button) — these are display tags for the configured model that
              happen to link out, not in-place actions. */}
          <Badge
            variant="outline"
            render={<Link to="/p/$projectId/settings" params={{ projectId }} />}
            className="h-auto gap-1.5 rounded-full px-2.5 py-[3px] font-mono text-[11px] font-normal text-muted-foreground"
          >
            worker <b className="font-medium text-foreground">{workerModel}</b>
          </Badge>
          <Badge
            variant="outline"
            render={<Link to="/p/$projectId/settings" params={{ projectId }} />}
            className="h-auto gap-1.5 rounded-full px-2.5 py-[3px] font-mono text-[11px] font-normal text-muted-foreground"
          >
            critic <b className="font-medium text-foreground">{criticModel}</b>
          </Badge>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>⏎</Kbd>
            </KbdGroup>
            to launch
          </span>
          <Button onClick={submit} disabled={!canSubmit} variant="primary">
            <ArrowUp className="size-4" />
            Launch run
          </Button>
        </InputGroupAddon>
      </InputGroup>

      <ChatModal
        projectId={projectId}
        open={chatOpen}
        initialIntent={chatIntent}
        onClose={() => setChatOpen(false)}
        onLaunched={armDigestWatch}
      />
    </div>
  );
}
