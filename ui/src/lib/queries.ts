import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type RegisterProjectInput } from "./api";

/** Query keys — resource-name first, then projectId, then params. Every
 *  project-scoped key carries the projectId so caches never collide across
 *  projects. WS change events invalidate everything, so staleness config is
 *  minimal. */
export const qk = {
  projects: ["projects"] as const,
  state: (p: string) => ["state", p] as const,
  runs: (p: string) => ["runs", p] as const,
  run: (p: string, id: string) => ["run", p, id] as const,
  runtimeFiles: (p: string, taskId: string) => ["runtime-files", p, taskId] as const,
  runtimeFile: (p: string, taskId: string, name: string) => ["runtime-file", p, taskId, name] as const,
  escalation: (p: string, id: string) => ["escalation", p, id] as const,
  config: (p: string) => ["config", p] as const,
};

/** Daemon-global project registry. */
export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: api.getProjects });

export const useState = (p: string) => useQuery({ queryKey: qk.state(p), queryFn: () => api.getState(p) });
export const useRuns = (p: string) => useQuery({ queryKey: qk.runs(p), queryFn: () => api.getRuns(p) });
export const useRun = (p: string, id: string) =>
  useQuery({ queryKey: qk.run(p, id), queryFn: () => api.getRun(p, id) });
export const useRuntimeFiles = (p: string, taskId: string) =>
  useQuery({ queryKey: qk.runtimeFiles(p, taskId), queryFn: () => api.getRuntimeFiles(p, taskId) });
export const useRuntimeFile = (p: string, taskId: string, name: string | null) =>
  useQuery({
    queryKey: qk.runtimeFile(p, taskId, name ?? ""),
    queryFn: () => api.getRuntimeFile(p, taskId, name as string),
    enabled: name !== null,
  });
export const useEscalation = (p: string, id: string, enabled = true) =>
  useQuery({ queryKey: qk.escalation(p, id), queryFn: () => api.getEscalation(p, id), enabled });

/** Curated project config (top bar + inspector rail). Static-ish — invalidated
 *  by WS like everything else. `enabled` guards the daemon-global routes. */
export const useConfig = (p: string) =>
  useQuery({ queryKey: qk.config(p), queryFn: () => api.getConfig(p), enabled: p !== "" });

/** Folder browser (M3). `path` undefined → roots view. Keyed by path so
 *  navigating dirs caches each level. */
export const useFsDirs = (path?: string) =>
  useQuery({ queryKey: ["fs-dirs", path ?? "__roots__"], queryFn: () => api.getFsDirs(path) });

/** Register a project; invalidates the project list on success so the sidebar updates. */
export const useRegisterProject = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterProjectInput) => api.postProject(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.projects }),
  });
};

/** Unregister a project; invalidates the project list on success. */
export const useDeleteProject = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.projects }),
  });
};

/** Rename a project; invalidates the project list on success so the sidebar + registry update. */
export const useRenameProject = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameProject(id, name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.projects }),
  });
};
