import { useParams } from "@tanstack/react-router";

/** The projectId from the active `/p/$projectId/...` route, or null on a
 *  daemon-global route (`/`, `/new`). The URL is now the single source of truth
 *  for which project is selected (replaces the old zustand `projectId`). */
export function useProjectId(): string | null {
  const params = useParams({ strict: false }) as { projectId?: string };
  return params.projectId ?? null;
}
