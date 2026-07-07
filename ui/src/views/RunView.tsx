import { useState, type ReactNode } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Layers, Pencil, Archive, ArchiveRestore, RotateCcw, Check, X } from "lucide-react";
import { useRun, usePatchRun, useState as useHarnessState } from "@/lib/queries";
import { useAppStore } from "@/lib/store";
import { useTaskIndex } from "@/lib/useTaskIndex";
import { timeAgo } from "@/lib/utils";
import { TaskCard } from "@/components/TaskCard";
import { DigestStrip } from "@/components/DigestStrip";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/input";
import { ErrorState, Loading } from "@/components/ui/Feedback";
import type { RunManifest } from "@/lib/api";

const route = getRouteApi("/p/$projectId/runs/$runId");

export function RunView() {
  const { projectId, runId } = route.useParams();
  const run = useRun(projectId, runId);
  const { index } = useTaskIndex(projectId);
  const state = useHarnessState(projectId);

  if (run.isLoading) return <Loading label="Loading run…" />;
  if (run.isError) return <ErrorState message={(run.error as Error).message} />;

  const manifest = run.data!;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
          <Layers className="size-3.5" />
          <span>run</span>
          <span className="text-muted-foreground normal-case tracking-normal">{manifest.runId}</span>
          <span>·</span>
          <span>{timeAgo(manifest.at)}</span>
          {manifest.archived_at !== undefined && (
            <span className="rounded border border-border px-1.5 py-px text-[9px] text-muted-foreground">archived</span>
          )}
        </div>
        <RunHeading projectId={projectId} manifest={manifest} />
        <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
          decomposed into {manifest.taskIds.length} task{manifest.taskIds.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <ol className="flex flex-col gap-2.5">
            {manifest.taskIds.map((id, i) => {
              const located = index.get(id);
              return (
                <li key={id} className="flex gap-3">
                  <div className="flex flex-col items-center pt-1">
                    <span className="grid size-6 place-items-center rounded-full border border-border bg-muted font-mono text-[10px] text-muted-foreground">
                      {i + 1}
                    </span>
                    {i < manifest.taskIds.length - 1 && (
                      <span className="w-px flex-1 bg-border mt-1" />
                    )}
                  </div>
                  <div className="flex-1 pb-1">
                    {located ? (
                      <TaskCard task={located.task} state={located.state} />
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-3 py-2.5 font-mono text-xs text-muted-foreground">
                        {id} — not in any queue (cleaned up or not yet materialized)
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <DigestStrip digest={state.data?.digestTail ?? ""} />
      </div>
    </div>
  );
}

/**
 * Run title (`name ?? intent`) + the operator actions bar: inline rename, archive/
 * unarchive toggle, and re-run (seeds the composer with this run's intent and
 * navigates home — no backend fork, just POST /orchestrate again). All edits go
 * through `PATCH /runs/:id`, which touches only the manifest index, never the queue.
 */
function RunHeading({ projectId, manifest }: { projectId: string; manifest: RunManifest }) {
  const patch = usePatchRun(projectId);
  const navigate = useNavigate();
  const setComposerSeed = useAppStore((s) => s.setComposerSeed);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const isArchived = manifest.archived_at !== undefined;
  const label = manifest.name ?? manifest.intent;

  const startRename = () => {
    setDraft(manifest.name ?? "");
    setEditing(true);
  };
  const saveRename = () => {
    // Empty draft clears the override (server trims "" → back to intent).
    patch.mutate({ runId: manifest.runId, patch: { name: draft } });
    setEditing(false);
  };
  const reRun = () => {
    setComposerSeed(manifest.intent);
    void navigate({ to: "/p/$projectId", params: { projectId } });
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 max-w-3xl">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveRename();
            if (e.key === "Escape") setEditing(false);
          }}
          maxLength={200}
          placeholder={manifest.intent}
          className="h-auto flex-1 rounded-lg px-3 py-1.5 font-sans text-lg"
        />
        <IconBtn title="Save" onClick={saveRename}>
          <Check className="size-4 text-clean" />
        </IconBtn>
        <IconBtn title="Cancel" onClick={() => setEditing(false)}>
          <X className="size-4 text-muted-foreground" />
        </IconBtn>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 max-w-3xl">
      <h1 className="flex-1 font-sans text-xl font-semibold leading-snug text-foreground">{label}</h1>
      <div className="flex shrink-0 items-center gap-0.5 pt-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        <IconBtn title="Rename run" onClick={startRename} disabled={patch.isPending}>
          <Pencil className="size-3.5 text-muted-foreground" />
        </IconBtn>
        <IconBtn
          title={isArchived ? "Unarchive run" : "Archive run"}
          onClick={() => patch.mutate({ runId: manifest.runId, patch: { archived: !isArchived } })}
          disabled={patch.isPending}
        >
          {isArchived ? <ArchiveRestore className="size-3.5 text-muted-foreground" /> : <Archive className="size-3.5 text-muted-foreground" />}
        </IconBtn>
        <IconBtn title="Re-run this intent" onClick={reRun}>
          <RotateCcw className="size-3.5 text-muted-foreground" />
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="size-7"
    >
      {children}
    </Button>
  );
}
