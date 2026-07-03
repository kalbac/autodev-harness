import { useEffect } from "react";
import type { ReactNode } from "react";
import { FolderX } from "lucide-react";
import { useProjects } from "@/lib/queries";
import { useAppStore } from "@/lib/store";
import { Loading, EmptyState, ErrorState } from "./ui/Feedback";

/**
 * Interim multi-project shim (see `lib/api.ts` module header): resolves the
 * FIRST project returned by `GET /projects` on boot and gates rendering of
 * the routed app until a project id is selected. A proper multi-project
 * shell (picker/switcher, project registration UI) replaces this in a later
 * module (M3).
 */
export function ProjectGate({ children }: { children: ReactNode }) {
  const projects = useProjects();
  const projectId = useAppStore((s) => s.projectId);
  const setProjectId = useAppStore((s) => s.setProjectId);

  useEffect(() => {
    if (!projectId && projects.data && projects.data.projects.length > 0) {
      setProjectId(projects.data.projects[0]!.id);
    }
  }, [projectId, projects.data, setProjectId]);

  if (projects.isLoading) {
    return (
      <div className="grid h-screen place-items-center bg-ink">
        <Loading label="Discovering projects…" />
      </div>
    );
  }

  if (projects.isError) {
    return (
      <div className="grid h-screen place-items-center bg-ink">
        <ErrorState message="Could not reach the daemon to list projects." />
      </div>
    );
  }

  if (!projects.data || projects.data.projects.length === 0) {
    return (
      <div className="grid h-screen place-items-center bg-ink">
        <EmptyState
          icon={FolderX}
          title="No projects registered"
          description="Add one to ~/.autodev/projects.json (UI registration coming in M3)."
        />
      </div>
    );
  }

  if (!projectId) {
    return (
      <div className="grid h-screen place-items-center bg-ink">
        <Loading label="Selecting project…" />
      </div>
    );
  }

  return <>{children}</>;
}
