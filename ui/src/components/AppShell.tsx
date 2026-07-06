import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useProjectId } from "@/lib/useProjectId";
import { Sidebar } from "./Sidebar";
import { SessionRail } from "./SessionRail";

/**
 * Three-region agent-desktop shell: persistent left sidebar + the routed main
 * area + a per-session inspector rail on the right. The rail shows only on
 * project session screens (home / run / board) — not on `/new`, either settings
 * screen, or a task-detail route (which has its own inline per-task inspector).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const projectId = useProjectId();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showRail =
    Boolean(projectId) &&
    pathname.startsWith("/p/") &&
    !pathname.includes("/tasks/") &&
    !pathname.endsWith("/settings");

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-hidden">{children}</main>
      {showRail && projectId && <SessionRail projectId={projectId} />}
    </div>
  );
}
