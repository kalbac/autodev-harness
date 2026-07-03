import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Query keys — resource-name first, then params. WS change events invalidate
 *  everything, so staleness config is minimal. */
export const qk = {
  projects: ["projects"] as const,
  state: ["state"] as const,
  runs: ["runs"] as const,
  run: (id: string) => ["run", id] as const,
  runtimeFiles: (taskId: string) => ["runtime-files", taskId] as const,
  runtimeFile: (taskId: string, name: string) => ["runtime-file", taskId, name] as const,
  escalation: (id: string) => ["escalation", id] as const,
};

/** Daemon-global project registry — drives `components/ProjectGate.tsx`'s
 *  default-project shim (see `lib/api.ts` module header). */
export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: api.getProjects });

export const useState = () => useQuery({ queryKey: qk.state, queryFn: api.getState });
export const useRuns = () => useQuery({ queryKey: qk.runs, queryFn: api.getRuns });
export const useRun = (id: string) =>
  useQuery({ queryKey: qk.run(id), queryFn: () => api.getRun(id) });
export const useRuntimeFiles = (taskId: string) =>
  useQuery({ queryKey: qk.runtimeFiles(taskId), queryFn: () => api.getRuntimeFiles(taskId) });
export const useRuntimeFile = (taskId: string, name: string | null) =>
  useQuery({
    queryKey: qk.runtimeFile(taskId, name ?? ""),
    queryFn: () => api.getRuntimeFile(taskId, name as string),
    enabled: name !== null,
  });
export const useEscalation = (id: string, enabled = true) =>
  useQuery({ queryKey: qk.escalation(id), queryFn: () => api.getEscalation(id), enabled });
