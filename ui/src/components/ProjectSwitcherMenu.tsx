import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown } from "lucide-react";
import { useProjects } from "@/lib/queries";

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-[3px] font-mono text-[11px] text-muted-foreground transition-colors hover:border-line-strong hover:text-text";

/**
 * The composer's project chip: click to open a menu of every registered
 * project (current one checked); picking another navigates to its home
 * (`/p/:projectId`) — the composer is always scoped to ONE project, so
 * switching means leaving this project's screen, not composing across two.
 * Closes on outside-click, same interaction language as `SettingsPopover`.
 */
export function ProjectSwitcherMenu({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const projects = useProjects();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const list = projects.data?.projects ?? [];

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className={CHIP}>
        project <b className="font-medium text-text">{projectName}</b>
        <ChevronDown className="size-3 text-subtle" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-56 rounded-[10px] border border-line-strong bg-surface-2 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
          {list.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[12px] text-subtle">No projects registered</div>
          ) : (
            list.map((p) => (
              <Link
                key={p.id}
                to="/p/$projectId"
                params={{ projectId: p.id }}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text transition-colors hover:bg-surface"
              >
                <span className="w-3.5 shrink-0">
                  {p.id === projectId && <Check className="size-3.5 text-primary" />}
                </span>
                <span className="truncate">{p.name}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
