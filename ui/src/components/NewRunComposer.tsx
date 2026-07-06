import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp, CircleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { qk, useConfig, useProjects } from "@/lib/queries";
import { useAppStore } from "@/lib/store";
import { useProjectId } from "@/lib/useProjectId";
import { cn } from "@/lib/utils";
import { ProjectSwitcherMenu } from "./ProjectSwitcherMenu";
import { Spinner } from "./ui/Feedback";
import { Badge } from "./ui/badge";
import { Button } from "./ui/Button";

/**
 * The "new run" intent box — the one write surface that launches work. It only
 * enqueues+triggers through the same validated orchestrator path the CLI uses
 * (R1-safe server-side); it cannot run/skip/reorder any gate step.
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
  const qc = useQueryClient();
  const projects = useProjects();
  const config = useConfig(projectId);

  const projectName = projects.data?.projects.find((p) => p.id === projectId)?.name ?? projectId;
  const cfg = config.data;
  const workerModel = cfg?.roles.worker.ladder[0] ?? "—";
  const criticModel = cfg ? `${cfg.roles.critic.model} · ${cfg.roles.critic.effort}` : "—";

  const launch = useMutation({
    mutationFn: (text: string) => api.postOrchestrate(projectId, text),
    onSuccess: () => {
      setIntent("");
      void qc.invalidateQueries({ queryKey: qk.runs(projectId) });
      void qc.invalidateQueries({ queryKey: qk.state(projectId) });
    },
  });

  const trimmed = intent.trim();
  const canSubmit = trimmed.length > 0 && !launch.isPending;

  const submit = () => {
    if (canSubmit) launch.mutate(trimmed);
  };

  const inFlight = launch.error instanceof ApiError && launch.error.status === 409;

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "rounded-xl border bg-card transition-colors focus-within:border-ring",
          launch.isError ? "border-broken/40" : "border-border",
        )}
      >
        <textarea
          autoFocus={autoFocus}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          placeholder="Describe a change to make — the orchestrator decomposes it into gated tasks…"
          rows={3}
          className="w-full resize-none bg-transparent px-4 pt-3.5 text-sm text-foreground placeholder:text-muted-foreground outline-none"
        />
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
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
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">⌘⏎ to launch</span>
          <Button onClick={submit} disabled={!canSubmit} variant="primary">
            {launch.isPending ? <Spinner className="text-primary-foreground" /> : <ArrowUp className="size-4" />}
            Launch run
          </Button>
        </div>
      </div>

      {launch.isSuccess && (
        <p className="px-1 text-xs text-clean">Run accepted — decomposing intent…</p>
      )}
      {launch.isError && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-broken">
          <CircleAlert className="size-3.5" />
          {inFlight
            ? "A run is already in flight — wait for it to settle, then try again."
            : `Could not launch: ${(launch.error as Error).message}`}
        </p>
      )}
    </div>
  );
}
