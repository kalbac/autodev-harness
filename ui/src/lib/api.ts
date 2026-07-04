/**
 * Typed client over the daemon's read/write API seam (src/api/server.ts).
 * Same-origin in production (the daemon serves this bundle); Vite proxies the
 * same paths to the daemon in dev. The dashboard holds NO authoritative state —
 * every shape here mirrors a server response and is re-fetched on WS change.
 *
 * MULTI-PROJECT: every project-scoped route lives under `/projects/:id/...` on
 * the daemon (`GET /projects` lists registered projects). The active project is
 * carried in the router path (`/p/:projectId/...`), so every project-scoped
 * method below takes `projectId` as its FIRST argument and prefixes the route
 * via `projectPath`. `getProjects` itself is the sole daemon-global
 * (unprefixed) call.
 */

export type QueueState = "pending" | "active" | "done" | "escalated" | "quarantine";

export const QUEUE_STATES: readonly QueueState[] = [
  "active",
  "escalated",
  "pending",
  "quarantine",
  "done",
];

/** Mirrors `src/blackboard/types.ts` Task. */
export interface Task {
  id: string;
  title: string;
  type: string;
  touches_contract_zone: boolean;
  writes_guard: boolean;
  model: string | null;
  success_commands: string[];
  forbidden_paths: string[];
  max_rounds: number | null;
  file_set: string[];
  depends_on: string[];
  contract_zones_touched: string[];
  needs_guard: boolean;
  acceptance: string[];
  phase?: string;
  body: string;
  path: string;
}

export interface StateResponse {
  queues: Record<QueueState, Task[]>;
  digestTail: string;
}

/** Mirrors the orchestrator run manifest (`<stateDir>/runs/<runId>.json`).
 *  `name`/`archived_at` are optional operator edits via `PATCH /runs/:id`. */
export interface RunManifest {
  runId: string;
  intent: string;
  taskIds: string[];
  at: number;
  /** Display override; when set the UI labels the run with it instead of `intent`. */
  name?: string;
  /** Soft-archive timestamp (ms). Present = archived (hidden from the default list). */
  archived_at?: number;
}

/** Body for `PATCH /runs/:id` — rename (`name`; empty string clears it) and/or
 *  archive (`archived`). At least one field required. */
export interface RunPatch {
  name?: string;
  archived?: boolean;
}

export interface EscalationReply {
  id: string;
  choice: "A" | "B";
  note: string;
  at: number;
}

/** Mirrors `GET /escalations/:id` (parsed from the on-disk `<id>.md`). */
export interface Escalation {
  id: string;
  reason: string;
  type: string;
  taskId: string;
  title: string;
  what: string;
  decision: string;
  optionA: string;
  optionB: string;
  costOfWrong: string;
  evidence: string;
  reply: EscalationReply | null;
}

/** Mirrors `GET /projects` (the daemon-global project registry list). */
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  status: string;
  error?: string;
}

/** Mirrors `GET /projects/:id/config` — the curated read-only config projection
 *  the shell renders (top bar + inspector rail). */
export interface ProjectConfigView {
  stateDir: string;
  allowedBranchPattern: string;
  gate: { checkCommand: string | null };
  worktree: { provision: string[] };
  roles: {
    orchestrator: { adapter: string; model: string; effort?: string };
    worker: { adapter: string; ladder: string[] };
    critic: { adapter: string; model: string; effort: string };
  };
}

/** Body for `PATCH /projects/:id/config` — a partial config write. Only the
 *  fields present are changed server-side; everything else (including fields
 *  this form doesn't cover at all) is preserved. Mirrors the subset of
 *  `ProjectConfigView` that the UI exposes for editing. */
export interface ProjectConfigForm {
  allowedBranchPattern?: string;
  gate?: { checkCommand?: string };
  worktree?: { provision?: string[] };
  roles?: {
    orchestrator?: { adapter?: string; model?: string; effort?: string };
    worker?: { adapter?: string; ladder?: string[] };
    critic?: { adapter?: string; model?: string; effort?: string };
  };
}

/** One directory entry from `GET /fs/dirs` (M3 folder browser). `path` is the
 *  absolute path for the next `?path=` request; for a symlink it is the resolved
 *  real target. */
export interface FsDirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  isRegistered: boolean;
  isSymlink?: boolean;
}

/** Mirrors `GET /fs/dirs` (M3). `path`/`parent` are null in the roots view. */
export interface FsDirsResponse {
  path: string | null;
  parent: string | null;
  entries: FsDirEntry[];
}

/** Body for `POST /projects` (M3 register). `config` maps to `ScaffoldFormSchema`. */
export interface RegisterProjectInput {
  path: string;
  name?: string;
  scaffold?: boolean;
  config?: unknown;
}

/** Mirrors `src/usage/usage.ts` TokenUsageDoc — the per-task `token-usage.json`
 *  runtime artifact the conductor writes, served by the generic runtime-file
 *  endpoint. Critic (plain `codex exec`) yields only a `tokens` total, no split. */
export interface TokenUsageDoc {
  worker: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    total_cost_usd: number;
  };
  critic: { tokens: number };
  total_cost_usd: number;
  updated_at: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body — keep the status line */
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

/**
 * Prefixes a project-scoped sub-path with `/projects/:id`. `projectId` is
 * supplied by the caller (threaded down from the router path via
 * `useProjectId()` / a route param) — the URL is the single source of truth for
 * which project is selected.
 */
function projectPath(projectId: string, subPath: string): string {
  return `/projects/${encodeURIComponent(projectId)}${subPath}`;
}

export const api = {
  /** Daemon-global — NOT project-scoped. Lists registered projects. */
  getProjects: () => req<{ projects: ProjectSummary[] }>("/projects"),

  /** Daemon-global folder browser (M3). No `path` → drive roots / `/`. */
  getFsDirs: (path?: string) =>
    req<FsDirsResponse>(`/fs/dirs${path !== undefined ? `?path=${encodeURIComponent(path)}` : ""}`),

  /** Register a project (+ optional `.autodev/` scaffold). 201 entry / 400 / 409 (`{error,code}`). */
  postProject: (input: RegisterProjectInput) =>
    req<ProjectSummary>("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),

  /** Unregister a project (registry entry only — never touches the folder). */
  deleteProject: (id: string) =>
    req<{ removed: string }>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Rename a project's display name (registry entry only — id and path never change). */
  renameProject: (id: string, name: string) =>
    req<ProjectSummary>(`/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  getState: (projectId: string) => req<StateResponse>(projectPath(projectId, "/state")),
  getRuns: (projectId: string, includeArchived = false) =>
    req<RunManifest[]>(projectPath(projectId, `/runs${includeArchived ? "?includeArchived=1" : ""}`)),
  getRun: (projectId: string, id: string) =>
    req<RunManifest>(projectPath(projectId, `/runs/${encodeURIComponent(id)}`)),

  /** Rename/archive a run manifest (index-only — never touches the queue/tasks).
   *  Returns the fresh manifest. See PATCH /runs/:id. */
  patchRun: (projectId: string, runId: string, patch: RunPatch) =>
    req<RunManifest>(projectPath(projectId, `/runs/${encodeURIComponent(runId)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  getRuntimeFiles: (projectId: string, taskId: string) =>
    req<string[]>(projectPath(projectId, `/tasks/${encodeURIComponent(taskId)}/runtime`)),
  getEscalation: (projectId: string, id: string) =>
    req<Escalation>(projectPath(projectId, `/escalations/${encodeURIComponent(id)}`)),
  getConfig: (projectId: string) => req<ProjectConfigView>(projectPath(projectId, "/config")),

  /** Write a partial config update (registry-adjacent, project-scoped). Returns
   *  the fresh curated config view. See PATCH /projects/:id/config. */
  updateProjectConfig: (projectId: string, form: Partial<ProjectConfigForm>) =>
    req<ProjectConfigView>(projectPath(projectId, "/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    }),

  /** Runtime files are raw text/json, not a JSON envelope — fetched as text. */
  async getRuntimeFile(
    projectId: string,
    taskId: string,
    name: string,
  ): Promise<{ text: string; truncated: boolean }> {
    const res = await fetch(
      projectPath(projectId, `/tasks/${encodeURIComponent(taskId)}/runtime/${encodeURIComponent(name)}`),
    );
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return { text: await res.text(), truncated: res.headers.get("x-truncated") === "true" };
  },

  /** Structured A/B reply. `note` is context-only and NEVER executed (server-enforced). */
  postReply: (projectId: string, id: string, choice: "A" | "B", note: string) =>
    req<EscalationReply>(projectPath(projectId, `/escalations/${encodeURIComponent(id)}/reply`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice, note }),
    }),

  /** Launch a run: enqueue+trigger only (R1-safe, server-side). 202 accepted / 409 in-flight. */
  async postOrchestrate(
    projectId: string,
    intent: string,
  ): Promise<{ accepted: boolean; intent: string }> {
    const res = await fetch(projectPath(projectId, "/orchestrate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent }),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const b = (await res.json()) as { error?: string };
        if (b?.error) msg = b.error;
      } catch {
        /* keep status line */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as { accepted: boolean; intent: string };
  },
};
