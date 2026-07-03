import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CircleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { qk } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { cn } from "@/lib/utils";
import { Spinner } from "./ui/Feedback";

/**
 * The "new run" intent box — the one write surface that launches work. It only
 * enqueues+triggers through the same validated orchestrator path the CLI uses
 * (R1-safe server-side); it cannot run/skip/reorder any gate step.
 */
export function NewRunComposer({ autoFocus = false }: { autoFocus?: boolean }) {
  // Rendered on the project home; the route guarantees projectId (`?? ""` for the type).
  const projectId = useProjectId() ?? "";
  const [intent, setIntent] = useState("");
  const qc = useQueryClient();

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
          "rounded-xl border bg-surface transition-colors focus-within:border-line-strong",
          launch.isError ? "border-broken/40" : "border-line",
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
          className="w-full resize-none bg-transparent px-4 pt-3.5 text-sm text-text placeholder:text-subtle outline-none"
        />
        <div className="flex items-center justify-between px-3 pb-3">
          <span className="font-mono text-[11px] text-subtle">⌘⏎ to launch</span>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-40 hover:opacity-90"
          >
            {launch.isPending ? <Spinner className="text-white" /> : <ArrowUp className="size-4" />}
            Launch run
          </button>
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
