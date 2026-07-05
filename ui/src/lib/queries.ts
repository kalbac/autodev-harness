import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type RegisterProjectInput, type ProjectConfigForm, type RunUsageSummary, type CriticVerdictDoc, type RunPatch } from "./api";

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
  sessionUsage: (p: string) => ["session-usage", p] as const,
  taskVerdict: (p: string, taskId: string) => ["task-verdict", p, taskId] as const,
  detectedAgents: ["detected-agents"] as const,
};

/** Cross-run token totals for the session rail (s25). Token count only — cost was
 *  intentionally stripped. Each bucket's `any` is false when no contributing run
 *  has a usage file yet, so the rail shows "—" instead of a misleading 0. */
export interface SessionUsage {
  thisRun: { tokens: number; any: boolean };
  today: { tokens: number; any: boolean };
  allTime: { tokens: number; any: boolean };
}

/** Daemon-global project registry. */
export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: api.getProjects });

export const useState = (p: string) => useQuery({ queryKey: qk.state(p), queryFn: () => api.getState(p) });
/** Runs list. `includeArchived` gets its own cache key (prefixed by `qk.runs(p)`
 *  so a single `invalidateQueries({queryKey: qk.runs(p)})` still refreshes both). */
export const useRuns = (p: string, includeArchived = false) =>
  useQuery({
    queryKey: includeArchived ? ([...qk.runs(p), "archived"] as const) : qk.runs(p),
    queryFn: () => api.getRuns(p, includeArchived),
  });
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
 * Cross-run token totals for the session rail (s25) — the first consumer of the
 * server-side per-run aggregate `GET /runs/:id/usage`, which retires the s22 N×M
 * client walk (one call per run instead of one per task). One runs-list fetch +
 * one `getRunUsage` per run, bucketed in a single pass: `thisRun` = the newest run
 * (server sorts newest-first), `today` = runs whose manifest `at` falls in the
 * local calendar day, `allTime` = every (non-archived) run. A run whose usage 404s
 * (manifest raced away) is skipped, never failing the whole summary. Token only.
 */
export const useSessionUsage = (p: string) =>
  useQuery({
    queryKey: qk.sessionUsage(p),
    enabled: p !== "",
    queryFn: async (): Promise<SessionUsage> => {
      const runs = await api.getRuns(p); // newest-first, non-archived
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayMs = startOfToday.getTime();
      const newestId = runs[0]?.runId ?? null;

      let thisRunTokens = 0;
      let thisRunAny = false;
      let todayTokens = 0;
      let todayAny = false;
      let allTokens = 0;
      let allAny = false;

      await Promise.all(
        runs.map(async (r) => {
          let u: RunUsageSummary;
          try {
            u = await api.getRunUsage(p, r.runId);
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) return; // run raced away
            throw err;
          }
          if (!u.any) return;
          allTokens += u.tokens;
          allAny = true;
          if (r.at >= todayMs) {
            todayTokens += u.tokens;
            todayAny = true;
          }
          if (r.runId === newestId) {
            thisRunTokens = u.tokens;
            thisRunAny = true;
          }
        }),
      );

      return {
        thisRun: { tokens: thisRunTokens, any: thisRunAny },
        today: { tokens: todayTokens, any: todayAny },
        allTime: { tokens: allTokens, any: allAny },
      };
    },
  });

/**
 * The persisted critic verdict for one task (s24): reads `critic-verdict.json` via the
 * existing runtime-file endpoint. 404-tolerant — an undecided task (still pending/active)
 * or a run predating verdict persistence has no file, so the query resolves to `null` and
 * the UI falls back to its state-synthesized verdict. A malformed/truncated file also
 * yields `null` rather than failing. Closes gotcha [ui/verdict-not-persisted] for the
 * committed-task case, where the synthesized verdict was a fabricated placeholder.
 */
export const useTaskVerdict = (p: string, taskId: string) =>
  useQuery({
    queryKey: qk.taskVerdict(p, taskId),
    enabled: p !== "" && taskId !== "",
    queryFn: async (): Promise<CriticVerdictDoc | null> => {
      let text: string;
      try {
        ({ text } = await api.getRuntimeFile(p, taskId, "critic-verdict.json"));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null; // no persisted verdict for this task
        throw err;
      }
      try {
        return JSON.parse(text) as CriticVerdictDoc;
      } catch {
        return null; // malformed/truncated — fall back to the synthesized verdict
      }
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

/** Rename/archive a run manifest; refreshes the run + the runs list (both the
 *  default and archived variants, via the shared `qk.runs` prefix). */
export const usePatchRun = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, patch }: { runId: string; patch: RunPatch }) => api.patchRun(projectId, runId, patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.run(projectId, data.runId), data);
      void qc.invalidateQueries({ queryKey: qk.runs(projectId) });
    },
  });
};

/** Folder browser (M3). `path` undefined → roots view. Keyed by path so
 *  navigating dirs caches each level. */
export const useFsDirs = (path?: string) =>
  useQuery({ queryKey: ["fs-dirs", path ?? "__roots__"], queryFn: () => api.getFsDirs(path) });

/** PATH-scan auto-detect of installed CLI agents (M2), daemon-global. A short
 *  `staleTime` (the PATH doesn't change often) and NO `refetchInterval` — this
 *  is a manual "Rescan" action (see the Global Settings panel), not a poll.
 *  Callers that want a rescan button use the returned `refetch`. */
export const useDetectedAgents = () =>
  useQuery({ queryKey: qk.detectedAgents, queryFn: api.getDetectedAgents, staleTime: 30_000 });

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
