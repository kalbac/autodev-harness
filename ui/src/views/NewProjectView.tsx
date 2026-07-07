import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { FsDirEntry, GitInitResponse } from "@/lib/api";
import { useSystemGit } from "@/lib/queries";
import { FolderBrowser } from "@/components/FolderBrowser";
import { RegisterForm } from "@/components/RegisterForm";

/**
 * "New Project" screen (mockup Frame 2 `.np`): a server-side folder browser on
 * the left, and a register form on the right once a git repo is selected. The
 * selection is lifted here so the browser can highlight the selected row while
 * the form drives it. On a successful register we jump straight to the new
 * project's home. The AppShell rail does not render on `/new` (its predicate
 * only matches `/p/` paths), so this owns the full main region.
 *
 * s30: also reads daemon-global git availability (`useSystemGit`) to gate the
 * folder browser's inline "init git" action and to show a git-not-installed
 * banner, and tracks the last successful `init git` result to show a brief
 * untracked-files hint (the operator's existing files are never auto-committed).
 */
export function NewProjectView() {
  const [selected, setSelected] = useState<FsDirEntry | null>(null);
  const navigate = useNavigate();
  const git = useSystemGit();
  const gitInstalled = git.data?.installed ?? true; // optimistic until known; the banner only shows on explicit false
  const [initHint, setInitHint] = useState<GitInitResponse | null>(null);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-4 h-14">
        <Link
          to="/"
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          back
        </Link>
        <span className="font-sans text-[15px] font-semibold text-foreground">New Project</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          register a git repo the daemon will orchestrate
        </span>
      </div>

      {git.data && !git.data.installed && (
        <div className="flex items-center gap-3 border-b border-border bg-broken/10 px-4 py-2.5 text-sm">
          <span className="text-foreground">
            git is not installed — the harness needs it to initialize and orchestrate projects.
          </span>
          <a
            href="https://git-scm.com/downloads"
            target="_blank"
            rel="noreferrer"
            className="ml-auto rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:bg-muted"
          >
            Install it now
          </a>
          <code className="font-mono text-[11px] text-muted-foreground">winget install Git.Git · brew install git</code>
        </div>
      )}

      {initHint && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Initialized on <code className="font-mono">{initHint.branch}</code>.
          {initHint.untrackedCount > 0
            ? ` ${initHint.untrackedCount} untracked file(s) — commit your baseline before the first run.`
            : ""}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 border-r border-border">
          <FolderBrowser
            selectedPath={selected?.path ?? null}
            onSelect={setSelected}
            gitInstalled={gitInstalled}
            onInitialized={setInitHint}
          />
        </div>
        {selected ? (
          <RegisterForm
            entry={selected}
            onRegistered={(project) =>
              void navigate({ to: "/p/$projectId", params: { projectId: project.id } })
            }
          />
        ) : (
          <div className="grid w-full max-w-md shrink-0 place-items-center p-8 text-center text-sm text-muted-foreground sm:w-96">
            Select a git repository on the left to register it.
          </div>
        )}
      </div>
    </div>
  );
}
