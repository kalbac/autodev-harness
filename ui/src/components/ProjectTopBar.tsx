import { Link } from "@tanstack/react-router";
import { GitBranch } from "lucide-react";
import { useConfig, useProjects } from "@/lib/queries";

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-[3px] font-mono text-[11px] text-muted-foreground";

/**
 * The project home top bar (s16 mockup `.top`): project name + path on the left,
 * a branch-pattern chip, and gate/board chips on the right. Every value degrades
 * to an em-dash while `useConfig`/`useProjects` load — the bar never crashes.
 */
export function ProjectTopBar({ projectId }: { projectId: string }) {
  const projects = useProjects();
  const config = useConfig(projectId);

  const project = projects.data?.projects.find((p) => p.id === projectId);
  const name = project?.name ?? projectId;
  const path = project?.path;

  // We don't track the live checked-out branch — show the configured pattern.
  const branch = config.data?.allowedBranchPattern ?? "—";
  const gate = config.data ? (config.data.gate.checkCommand ?? "—") : "—";

  return (
    <div className="flex items-center gap-2.5 border-b border-line px-[18px] py-3">
      <span className="font-sans text-[15px] font-semibold text-text">{name}</span>
      {path && <span className="font-mono text-[11px] text-subtle">{path}</span>}
      <span className={CHIP}>
        <GitBranch className="size-3" />
        <b className="font-medium text-text">{branch}</b>
      </span>
      <div className="ml-auto flex gap-2">
        <span className={CHIP}>
          gate <b className="font-medium text-text">{gate}</b>
        </span>
        <Link
          to="/p/$projectId/board"
          params={{ projectId }}
          className={CHIP + " transition-colors hover:border-line-strong hover:text-text"}
        >
          Board
        </Link>
      </div>
    </div>
  );
}
