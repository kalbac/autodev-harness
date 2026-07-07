import { Link } from "@tanstack/react-router";
import { Check, ChevronDown } from "lucide-react";
import { useProjects } from "@/lib/queries";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-[3px] font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground";

/**
 * The composer's project chip: click to open a menu of every registered
 * project (current one checked); picking another navigates to its home
 * (`/p/:projectId`) — the composer is always scoped to ONE project, so
 * switching means leaving this project's screen, not composing across two.
 * Built on shadcn's `DropdownMenu` (Base UI `Menu`): outside-click, escape,
 * and focus handling are owned by the primitive now (no more hand-rolled
 * ref + mousedown listener), and picking an item auto-closes the menu.
 */
export function ProjectSwitcherMenu({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const projects = useProjects();
  const list = projects.data?.projects ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={CHIP}>
        project <b className="font-medium text-foreground">{projectName}</b>
        <ChevronDown className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        {list.length === 0 ? (
          <div className="px-2.5 py-1.5 text-[12px] text-muted-foreground">No projects registered</div>
        ) : (
          list.map((p) => (
            <DropdownMenuItem
              key={p.id}
              render={<Link to="/p/$projectId" params={{ projectId: p.id }} />}
              className="gap-2 px-2.5 py-1.5 text-[13px] text-foreground"
            >
              <span className="w-3.5 shrink-0">
                {p.id === projectId && <Check className="size-3.5 text-primary" />}
              </span>
              <span className="truncate">{p.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
