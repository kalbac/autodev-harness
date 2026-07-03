import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

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
