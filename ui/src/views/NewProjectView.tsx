import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { FsDirEntry } from "@/lib/api";
import { FolderBrowser } from "@/components/FolderBrowser";
import { RegisterForm } from "@/components/RegisterForm";

/**
 * "New Project" screen (mockup Frame 2 `.np`): a server-side folder browser on
 * the left, and a register form on the right once a git repo is selected. The
 * selection is lifted here so the browser can highlight the selected row while
 * the form drives it. On a successful register we jump straight to the new
 * project's home. The AppShell rail does not render on `/new` (its predicate
 * only matches `/p/` paths), so this owns the full main region.
 */
export function NewProjectView() {
  const [selected, setSelected] = useState<FsDirEntry | null>(null);
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 h-14">
        <Link
          to="/"
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-text"
        >
          <ArrowLeft className="size-3.5" />
          back
        </Link>
        <span className="font-display text-[15px] font-semibold text-text">New Project</span>
        <span className="font-mono text-[11px] text-subtle">
          register a git repo the daemon will orchestrate
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 border-r border-line">
          <FolderBrowser selectedPath={selected?.path ?? null} onSelect={setSelected} />
        </div>
        {selected ? (
          <RegisterForm
            entry={selected}
            onRegistered={(project) =>
              void navigate({ to: "/p/$projectId", params: { projectId: project.id } })
            }
          />
        ) : (
          <div className="grid w-full max-w-md shrink-0 place-items-center p-8 text-center text-sm text-muted sm:w-96">
            Select a git repository on the left to register it.
          </div>
        )}
      </div>
    </div>
  );
}
