import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type RegisterProjectInput, type ProjectConfigForm, type TokenUsageDoc } from "./api";

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
  runUsage: (p: string, runId: string) => ["run-usage", p, runId] as const,
};

/** Client-side token aggregate for one run: the sum of its tasks' `token-usage.json`
 *  artifacts (s22). `any` is false when NO task in the run has a usage file yet
 *  (run just started / older run predating instrumentation) so the UI can show "—". */
export interface RunUsageSummary {
  tokens: number;
  cost: number;
  any: boolean;
}

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

/**
 * Token/usage summary for a run, aggregated ON THE CLIENT (s22 scope decision):
 * fetch each task's `token-usage.json` via the existing runtime-file endpoint and
 * sum. A task with no usage file yet (404) is skipped — never fails the whole
 * summary — so the rail degrades to "—" cleanly. `runId` null disables the query.
 */
export const useRunUsage = (p: string, runId: string | null) =>
  useQuery({
    queryKey: qk.runUsage(p, runId ?? ""),
    enabled: p !== "" && runId !== null,
    queryFn: async (): Promise<RunUsageSummary> => {
      const run = await api.getRun(p, runId as string);
      let tokens = 0;
      let cost = 0;
      let any = false;
      await Promise.all(
        run.taskIds.map(async (taskId) => {
          let text: string;
          try {
            ({ text } = await api.getRuntimeFile(p, taskId, "token-usage.json"));
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) return; // no usage for this task yet
            throw err;
          }
          let doc: TokenUsageDoc;
          try {
            doc = JSON.parse(text) as TokenUsageDoc;
          } catch {
            return; // malformed/truncated usage file — skip, don't fail the summary
          }
          any = true;
          tokens +=
            doc.worker.input_tokens +
            doc.worker.output_tokens +
            doc.worker.cache_read_input_tokens +
            doc.worker.cache_creation_input_tokens +
            doc.critic.tokens;
          cost += doc.total_cost_usd;
        }),
      );
      return { tokens, cost, any };
    },
  });

/** Curated project config (top bar + inspector rail). Static-ish — invalidated
 *  by WS like everything else. `enabled` guards the daemon-global routes. */
export const useConfig = (p: string) =>
  useQuery({ queryKey: qk.config(p), queryFn: () => api.getConfig(p), enabled: p !== "" });

/** Write a partial project config update; invalidates this project's config
 *  query (and the daemon-wide project list, since a broken config can become
 *  buildable/renamed status can shift) on success. */
export const useUpdateProjectConfig = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: ProjectConfigForm) => api.updateProjectConfig(projectId, form),
    onSuccess: (data) => {
      qc.setQueryData(qk.config(projectId), data); // optimistic: server already returned the fresh view
      void qc.invalidateQueries({ queryKey: qk.projects });
    },
  });
};

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
