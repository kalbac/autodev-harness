import { useEffect, useState, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useProjectId } from "@/lib/useProjectId";
import { AppSidebar } from "./Sidebar";
import { SessionRailZone } from "./SessionRail";
import { SidebarProvider } from "./ui/sidebar";

// Desktop-only responsiveness: the shell targets comfort down to 1280px, then
// compacts. At/above 1280 the sidebar is expanded; below it auto-collapses to
// the icon rail. (The session rail hides below 1120px — see SessionRailZone.)
const DESKTOP_EXPANDED = "(min-width: 1280px)";

/**
 * Owns the sidebar open state and pins it to viewport width: expanded ≥1280px,
 * auto-collapsed to the icon rail below. A manual toggle (SidebarTrigger,
 * Ctrl/Cmd+B, or the drag rail) flows back through `onOpenChange` and overrides
 * the width default until the next breakpoint crossing re-snaps it.
 */
function SidebarShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(
    () => typeof window === "undefined" || window.matchMedia(DESKTOP_EXPANDED).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_EXPANDED);
    const onChange = (e: MediaQueryListEvent) => setOpen(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <SidebarProvider
      open={open}
      onOpenChange={setOpen}
      className="h-screen overflow-hidden bg-background text-foreground"
    >
      {children}
    </SidebarProvider>
  );
}

/**
 * Three-region agent-desktop shell: a collapsible left sidebar (shadcn block) +
 * the routed main area + a per-session inspector rail on the right. The rail
 * shows only on project session screens (home / run / board) — not on `/new`,
 * either settings screen, or a task-detail route (which has its own inline
 * per-task inspector) — and auto-hides on narrow desktops (SessionRailZone).
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
    <SidebarShell>
      <AppSidebar />
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
        {showRail && projectId && <SessionRailZone projectId={projectId} />}
      </div>
    </SidebarShell>
  );
}
