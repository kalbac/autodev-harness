import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CheckSquare, MessageSquare, Plus } from "lucide-react";
import { useThreads } from "@/lib/queries";
import { useProjectId } from "@/lib/useProjectId";
import { toneVar } from "@/lib/status";
import type { ThreadStatus } from "@/lib/api";
import { Spinner } from "./ui/spinner";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";

/**
 * The sidebar's live-thread rail (s40). Lists the project's orchestrator threads
 * newest-first, each linking to its `/t/:threadId` main-screen view with a
 * status glyph. A "New thread" action at the top resets to the fresh-thread hero
 * by navigating home with `?compose=new` (ThreadView reads that search param and
 * shows the start composer regardless of any existing newest thread).
 *
 * Renders nothing off a project route (no projectId) — the threads query is
 * disabled there anyway.
 */
export function ThreadList() {
  const projectId = useProjectId();
  const navigate = useNavigate();
  const threads = useThreads(projectId ?? "");

  if (!projectId) return null;

  const rows = threads.data?.threads ?? [];

  return (
    <SidebarGroup className="min-h-0">
      <SidebarGroupLabel>Threads</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="New thread"
              onClick={() =>
                void navigate({ to: "/p/$projectId", params: { projectId }, search: { compose: "new" } })
              }
              className="font-mono text-xs text-muted-foreground"
            >
              <Plus className="size-4 text-primary" />
              <span>New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          {rows.map((t) => (
            <SidebarMenuItem key={t.id}>
              <SidebarMenuButton
                tooltip={t.title}
                render={
                  <Link to="/p/$projectId/t/$threadId" params={{ projectId, threadId: t.id }} />
                }
              >
                <ThreadGlyph status={t.status} />
                <span className="truncate">{t.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Distinct glyph per thread lifecycle state, tinted by the inspector tone —
 *  shape carries the meaning (same convention as SessionRail's PlanGlyph). */
function ThreadGlyph({ status }: { status: ThreadStatus }) {
  if (status === "running")
    return <Spinner className="size-4" strokeWidth={2.5} style={{ color: toneVar.working }} />;
  if (status === "done")
    return <CheckSquare className="size-4" strokeWidth={2.5} style={{ color: toneVar.clean }} />;
  if (status === "error")
    return <AlertTriangle className="size-4" strokeWidth={2.5} style={{ color: toneVar.broken }} />;
  // chatting
  return <MessageSquare className="size-4 text-muted-foreground" strokeWidth={2} />;
}
