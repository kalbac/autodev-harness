import { Link } from "@tanstack/react-router";
import { Plus, Terminal } from "lucide-react";
import { useProjects } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { useAppStore } from "@/lib/store";
import { ProjectRow } from "./ProjectRow";
import { SidebarSettingsMenu } from "./SettingsPopover";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  SidebarRail,
} from "./ui/sidebar";

/**
 * Multi-project sidebar, built on the shadcn `sidebar` block (Base UI) with the
 * `inset` variant so the sidebar reads as its own panel and the routed content
 * floats as a separate card. Brand + New Project → header; the project list
 * (each active project expandable to its last-5 runs, sub-menu auto-hidden when
 * collapsed) → content; settings + daemon status (native DropdownMenu) → footer.
 * `collapsible="icon"` gives the desktop icon-rail; the shell (AppShell) drives
 * collapse by viewport width, and Ctrl/Cmd+B / the rail toggle it manually.
 */
export function AppSidebar() {
  const projects = useProjects();
  const activeProjectId = useProjectId();
  const conn = useAppStore((s) => s.conn);

  const activeProject = projects.data?.projects.find((p) => p.id === activeProjectId);

  return (
    <Sidebar collapsible="icon" variant="inset">
      {/* Brand + collapse trigger */}
      <SidebarHeader className="h-14 flex-row items-center gap-2.5 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-[color-mix(in_srgb,var(--primary)_16%,transparent)] text-primary group-data-[collapsible=icon]:hidden">
          <Terminal className="size-4" />
        </div>
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <div className="font-sans text-sm font-semibold leading-tight text-sidebar-foreground">Autodev</div>
          <div className="font-mono text-[10px] uppercase leading-tight tracking-wider text-muted-foreground">
            harness
          </div>
        </div>
        <SidebarTrigger className="shrink-0 text-muted-foreground" />
      </SidebarHeader>

      <SidebarContent>
        {/* New Project */}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New Project"
                render={<Link to="/new" />}
                className="border border-border bg-sidebar-accent font-mono text-xs hover:bg-sidebar-accent/70"
              >
                <Plus className="size-4 text-primary" />
                <span>New Project</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* Projects */}
        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.isError ? (
                <p className="px-2 py-3 text-xs text-broken group-data-[collapsible=icon]:hidden">
                  daemon unreachable
                </p>
              ) : (
                projects.data?.projects.map((p) => (
                  <ProjectRow key={p.id} project={p} active={p.id === activeProjectId} />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Settings + daemon status — native DropdownMenu (NavUser pattern) */}
      <SidebarFooter>
        <SidebarSettingsMenu
          projectId={activeProjectId}
          projectName={activeProject?.name}
          conn={conn}
        />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
