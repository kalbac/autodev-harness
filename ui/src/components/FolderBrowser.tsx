import { useState } from "react";
import { ArrowUp, Folder, FolderGit2 } from "lucide-react";
import type { FsDirEntry } from "@/lib/api";
import { useFsDirs } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Loading, ErrorState } from "./ui/Feedback";

/**
 * Server-side folder browser (mockup Frame 2 `.browser`). Lists directories only
 * (the daemon's `GET /fs/dirs`), badges git repos + already-registered ones, and
 * exposes a `select` pill on git-repos that are not yet registered. Clicking a
 * row navigates into that directory; the up-one-level row walks back out. Roots
 * view (drives / `/`) is shown when no path is set. The daemon is the single
 * source of truth for what is a git repo / registered — this only renders it.
 */
export function FolderBrowser({
  selectedPath,
  onSelect,
}: {
  selectedPath: string | null;
  onSelect: (entry: FsDirEntry) => void;
}) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const dirs = useFsDirs(path);

  if (dirs.isLoading) return <Loading label="Reading directory…" />;
  if (dirs.isError) return <ErrorState message={(dirs.error as Error).message} />;
  if (!dirs.data) return null;

  const { path: here, parent, entries } = dirs.data;

  return (
    <div className="min-w-0 flex-1 overflow-auto p-4">
      {/* Breadcrumb — the current directory (or the roots label). */}
      <div className="mb-2.5 truncate font-mono text-xs text-muted-foreground">
        📁 <b className="text-foreground">{here ?? "This PC"}</b>
      </div>

      {entries.length === 0 && (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">No sub-directories.</p>
      )}

      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => {
          const Icon = entry.isGitRepo ? FolderGit2 : Folder;
          const selectable = entry.isGitRepo && !entry.isRegistered;
          const selected = selectedPath !== null && entry.path === selectedPath;
          return (
            <li key={entry.path}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setPath(entry.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPath(entry.path);
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-muted",
                  selected && "border border-border bg-muted hover:bg-muted",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-foreground">{entry.name}</span>
                {entry.isGitRepo && (
                  <span className="shrink-0 rounded-[5px] border border-[color-mix(in_srgb,var(--color-clean)_40%,transparent)] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.06em] text-clean">
                    git
                  </span>
                )}
                {entry.isRegistered && (
                  <span className="shrink-0 rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.06em] text-muted-foreground">
                    registered
                  </span>
                )}
                {selectable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(entry);
                    }}
                    className="ml-auto shrink-0 rounded-md border border-[color-mix(in_srgb,var(--primary)_45%,transparent)] px-2 py-0.5 font-mono text-[10px] text-primary transition-colors hover:bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]"
                  >
                    select
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {parent !== null && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setPath(parent ?? undefined)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPath(parent ?? undefined);
            }
          }}
          className="mt-0.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          <ArrowUp className="size-4 shrink-0" />
          up one level
        </div>
      )}
    </div>
  );
}
