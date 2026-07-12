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
  /** A = accept/release → quarantine; B = rework → pending; C = commit-on-accept
   *  (operator gate-override) → done. */
  choice: "A" | "B" | "C";
  note: string;
  at: number;
  /** Present only on a successful choice "C": the override commit hash. */
  commit?: string;
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
  gate: { checkCommand: string | null; agentCi: { enabled: boolean } };
  worktree: { provision: string[] };
  roles: {
    orchestrator: { adapter: string; model: string; effort?: string };
    worker: { adapter: string; ladder: string[] };
    critic: { adapter: string; model: string; effort: string };
    /** Present ONLY when the operator explicitly configured planner in
     *  `.autodev/config.yaml`; undefined otherwise (planner is optional — when
     *  unset the orchestrator handles planning). Mirrors orchestrator's shape. */
    planner?: { adapter: string; model: string; effort?: string };
  };
  /** Worker ambient-extension isolation (M2), always projected as plain
   *  booleans — all default `false` (the worker inherits the full ambient
   *  ~/.claude + project extension set unless the operator opts in). Mirrors
   *  `src/api/config-view.ts`'s `buildProjectConfigView` projection. */
  isolation: { worker: { cleanRoom: boolean; mcp: boolean; skills: boolean } };
  /** Read-only policy toggle the UI shows but never writes. */
  policy: { heterogeneity: "warn" | "off" };
  /** Server-computed warnings (rendered verbatim) — non-empty when worker &
   *  critic share an adapter family AND `policy.heterogeneity === "warn"`. */
  heterogeneityWarnings: string[];
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
    planner?: { adapter?: string; model?: string; effort?: string };
  };
  /** Only present sub-fields are changed server-side (see `ScaffoldFormSchema`
   *  in `src/registry/scaffold.ts`); omitted fields — including the whole
   *  `isolation` key — are left untouched. */
  isolation?: { worker?: { cleanRoom?: boolean; mcp?: boolean; skills?: boolean } };
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

/** Mirrors `GET /system/git` (s30) — daemon-global, is `git` installed. */
export interface SystemGitStatus {
  installed: boolean;
  version?: string;
}

/** Mirrors the success body of `POST /fs/git-init` (s30). */
export interface GitInitResponse {
  branch: string;
  untrackedCount: number;
}

/** One entry in a supported agent's static model catalog (M2 PATH-scan detect). */
export interface AgentModelOption {
  id: string;
  label?: string;
}

/** Mirrors `src/detect/detect-agents.ts` DetectedAgent — one entry from
 *  `GET /agents/detect` (M2). `path`/`version` are present only when the
 *  binary resolved on PATH (and, for `version`, the probe succeeded); `models`/
 *  `efforts` are present only for catalog entries that declare them (claude has
 *  no `efforts`). Catalog order (claude, codex, then the display-only entries)
 *  is preserved by the daemon. */
export interface DetectedAgent {
  id: string;
  name: string;
  supported: boolean;
  available: boolean;
  path?: string;
  version?: string;
  models?: AgentModelOption[];
  efforts?: string[];
  installUrl?: string;
}

/** Mirrors `src/usage/usage.ts` TokenUsageDoc — the per-task `token-usage.json`
 *  runtime artifact the conductor writes, served by the generic runtime-file
 *  endpoint. Critic (plain `codex exec`) yields only a `tokens` total, no split.
 *  Token count only — cost was intentionally stripped (s25). A legacy on-disk doc
 *  may still carry a `total_cost_usd`; it is simply ignored. */
export interface TokenUsageDoc {
  worker: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  critic: { tokens: number };
  updated_at: number;
}

/** Mirrors `src/usage/usage.ts` RunUsageSummary — the server-side per-run token
 *  aggregate from `GET /runs/:id/usage` (s24). Sums each task's `token-usage.json`
 *  server-side, so a cross-run total avoids the s22 N×M client walk.
 *  `tasksWithUsage <= taskCount`; `any` is false when no task in the run has a
 *  usage file yet. Token count only (no cost). */
export interface RunUsageSummary {
  tokens: number;
  any: boolean;
  taskCount: number;
  tasksWithUsage: number;
}

/** Mirrors `src/critic/verdict.ts` CriticVerdictDoc — the per-task `critic-verdict.json`
 *  runtime artifact the conductor writes at a task's DECISIVE point (the clean verdict
 *  that commits, or the parseable verdict that escalates), served by the generic
 *  runtime-file endpoint. Lets the dashboard render a REAL verdict seal for a committed
 *  task instead of a synthesized one (gotcha [ui/verdict-not-persisted]). */
export interface CriticVerdictDoc {
  verdict: "clean" | "broken" | "uncertain";
  confidence: number;
  notes: string;
  broken_contracts: { zone: string; file: string; line: number; evidence: string }[];
  diff_sha256?: string;
  updated_at: number;
}

/** Mirrors `src/gate/ci-status.ts` CiStatus — the rolling summary persisted at
 *  `runtime/<taskId>/agent-ci-status.json`, read via the generic runtime-file
 *  endpoint (like `CriticVerdictDoc`/`TokenUsageDoc`). */
export interface CiStatus {
  phase: "running" | "passed" | "failed";
  workflow: string | null;
  steps: { done: number; total: number };
  failedSteps: string[];
}

export type CiCapabilityMode = "native" | "wsl" | "unavailable";

/** Mirrors `src/gate/agent-ci-exec.ts` AgentCiCapability — the payload of
 *  `GET /projects/:id/ci/capability` (best-effort probe of whether agent-ci
 *  can run for this project: native, via WSL, or unavailable). */
export interface CiCapability {
  mode: CiCapabilityMode;
  reason?: "needs-wsl-on-windows" | "needs-node-in-wsl";
  detail: string;
}

/** One CI event frame as delivered over SSE (mirrors `src/gate/agent-ci-events.ts`
 *  AgentCiEvent union). */
export type CiEventFrame =
  | { kind: "run-start"; runId?: string }
  | { kind: "job-start"; job: string; runner?: string; workflow?: string }
  | { kind: "step-start"; job: string; step: string; index: number }
  | { kind: "step-finish"; job: string; step: string; index: number; status: string; durationMs?: number }
  | { kind: "job-finish"; job: string; status: string; durationMs?: number }
  | { kind: "run-finish"; status: string }
  | { kind: "other" };

/** Mirrors `src/detect/agent-extensions.ts` McpServerStatus. */
export interface McpServerStatus {
  name: string;
  status: string;
}

/** Mirrors `src/detect/agent-extensions.ts` AgentExtensions — the payload of
 *  `GET /projects/:id/agent-extensions` (M2), a best-effort, streaming visibility
 *  probe of what the worker `claude -p` child inherits under the project's
 *  CURRENTLY SAVED isolation config. `model` is present only when the probe's
 *  `init` event carried one. */
export interface AgentExtensions {
  model?: string;
  cwd: string;
  mcp: McpServerStatus[];
  skills: string[];
  slashCommands: string[];
  agents: string[];
}

/** Narrower mirror (server-shape subset) of `TaskSpec` from the orchestrator
 *  chat's proposed-decomposition preview -- the UI only needs enough to render
 *  a task-card list, not the full spec the server persists. */
export interface ChatTaskSpecPreview {
  id: string;
  title: string;
  type: string;
  file_set: string[];
}

/** One reply turn from the orchestrator chat (`POST /chat` and
 *  `POST /chat/:sessionId/message` share this response shape). */
export interface ChatTurn {
  reply: string;
  proposedSpecs: ChatTaskSpecPreview[];
}

export type ThreadStatus = "chatting" | "running" | "done" | "error";

/** Mirrors the daemon's thread registry entry — one row from `GET /projects/:id/threads`
 *  (s40 live orchestrator presence). */
export interface ThreadMeta {
  id: string;
  title: string;
  created_at: number;
  run_id?: string;
  status: ThreadStatus;
}

export type ActivityKind = "worker" | "gate" | "agent_ci" | "critic" | "merge" | "escalation" | "run";
export type ActivityStatus = "running" | "ok" | "warn" | "error";

/** Narrower mirror (server-shape subset) of a plan spec inside a thread's persisted
 *  "plan" entry -- same idiom as `ChatTaskSpecPreview` for the pre-launch chat. */
export interface PlanSpecPreview {
  id: string;
  title: string;
  type: string;
  file_set: string[];
}

/** One persisted thread entry, as returned in `GET /threads/:tid`'s `entries` array
 *  and replayed/streamed live over `GET /threads/:tid/stream`. The `token` SSE frame
 *  (live-typing text) is NOT a member of this union -- it is a transient streaming
 *  signal, not a persisted entry; see `useThreadStream`. */
export type ThreadEntry =
  | { ts: number; type: "operator_msg"; text: string }
  | { ts: number; type: "orchestrator_msg"; text: string; milestone?: string }
  | {
      ts: number;
      type: "activity";
      kind: ActivityKind;
      ref: { taskId?: string; runId?: string };
      summary: string;
      status: ActivityStatus;
    }
  | { ts: number; type: "plan"; specs: PlanSpecPreview[] }
  | { ts: number; type: "run_link"; runId: string };

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

  /** Daemon-global: is git installed. 404s when the daemon has no admin port. */
  getSystemGit: () => req<SystemGitStatus>("/system/git"),

  /** `git init` + `^autodev/` branch for a non-git folder. 200 {branch,untrackedCount} / 409 / 400. */
  gitInit: (path: string) =>
    req<GitInitResponse>("/fs/git-init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),

  /** Daemon-global PATH-scan auto-detect of installed CLI agents (M2). 404s when
   *  the daemon has no admin port — the endpoint is otherwise best-effort/never-
   *  throws server-side, so callers should treat any failure as "detection
   *  unavailable", not a crash. Unwraps the `{agents}` envelope here (unlike
   *  `getProjects`, which returns its envelope as-is) since M2 has no other
   *  consumer of the raw shape. */
  getDetectedAgents: async (): Promise<DetectedAgent[]> => {
    const { agents } = await req<{ agents: DetectedAgent[] }>("/agents/detect");
    return agents;
  },

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

  /** Server-side per-run token aggregate (sums each task's `token-usage.json`
   *  server-side — the clean path that avoids N×M client fetches). See GET /runs/:id/usage. */
  getRunUsage: (projectId: string, runId: string) =>
    req<RunUsageSummary>(projectPath(projectId, `/runs/${encodeURIComponent(runId)}/usage`)),

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

  /** Best-effort visibility scan of what the worker CLI inherits under this
   *  project's CURRENT saved isolation config (M2). Spawns the real `claude`
   *  and can take a few seconds; `extensions` is `null` when the probe found
   *  nothing (never throws for that reason — only a genuine HTTP/network
   *  failure or a project with no scan capability, which 404s). See
   *  GET /projects/:id/agent-extensions. */
  getAgentExtensions: (projectId: string) =>
    req<{ extensions: AgentExtensions | null }>(projectPath(projectId, "/agent-extensions")),

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

  /** Structured A/B/C reply. `note` is context-only and NEVER executed (server-enforced).
   *  Choice "C" (commit-on-accept override) may 409 with a refusal reason — surfaced as
   *  the thrown ApiError message. */
  postReply: (projectId: string, id: string, choice: "A" | "B" | "C", note: string) =>
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

  /** Start a pre-launch chat session. 409 if one is already open for this project. */
  async postChatStart(projectId: string, intent: string): Promise<{ sessionId: string } & ChatTurn> {
    const res = await fetch(projectPath(projectId, "/chat"), {
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
    return (await res.json()) as { sessionId: string } & ChatTurn;
  },

  /** Send one operator turn. The reply also streams token-by-token over the
   *  EventSource opened via `chatStreamUrl` -- this call's resolved value is
   *  the same final turn, useful as a fallback if the stream missed anything. */
  async postChatMessage(projectId: string, sessionId: string, message: string): Promise<ChatTurn> {
    const res = await fetch(projectPath(projectId, `/chat/${encodeURIComponent(sessionId)}/message`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
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
    return (await res.json()) as ChatTurn;
  },

  /** Confirm: closes the chat session and launches the SAME `/orchestrate`
   *  path as a plain one-shot launch -- `finalIntent` is assembled CLIENT-SIDE
   *  from the operator's own messages (never the LLM's). */
  async postChatConfirm(
    projectId: string,
    sessionId: string,
    finalIntent: string,
  ): Promise<{ accepted: boolean; intent: string }> {
    const res = await fetch(projectPath(projectId, "/chat/confirm"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, finalIntent }),
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

  /** Cancel: kills the session, nothing was ever enqueued. */
  async deleteChat(projectId: string, sessionId: string): Promise<void> {
    const res = await fetch(projectPath(projectId, `/chat/${encodeURIComponent(sessionId)}`), {
      method: "DELETE",
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
  },

  /** URL for the token-streaming SSE connection -- the CALLER opens this with
   *  `new EventSource(...)` (a raw URL, not a fetch-based client method). */
  chatStreamUrl(projectId: string, sessionId: string): string {
    return projectPath(projectId, `/chat/${encodeURIComponent(sessionId)}/stream`);
  },

  /** Best-effort probe of whether agent-ci can run for this project (native,
   *  via WSL, or unavailable). 404s when the daemon has no admin port -- callers
   *  should treat any failure as "unknown", not a crash. See GET /ci/capability. */
  getCiCapability: (projectId: string) => req<CiCapability>(projectPath(projectId, "/ci/capability")),

  /** URL for the CI event SSE connection -- the CALLER opens this with
   *  `new EventSource(...)`, same idiom as `chatStreamUrl`. On connect the
   *  server replays the persisted history (`agent-ci-status.json`'s sibling
   *  ndjson log) before streaming live events. */
  ciEventsUrl(projectId: string, taskId: string): string {
    return projectPath(projectId, `/ci/${encodeURIComponent(taskId)}/stream`);
  },

  /** Live orchestrator threads (s40) -- list, newest-first (server order). */
  getThreads: (projectId: string) => req<{ threads: ThreadMeta[] }>(projectPath(projectId, "/threads")),

  /** Start a new live thread. `{threadId}` -- the orchestrator narrates asynchronously;
   *  entries arrive over `threadStreamUrl`. */
  createThread: (projectId: string, intent: string) =>
    req<{ threadId: string }>(projectPath(projectId, "/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent }),
    }),

  /** One thread's full persisted state: `meta` + `entries`. The SSE stream (`threadStreamUrl`)
   *  replays these same entries on connect, then continues live. */
  getThread: (projectId: string, threadId: string) =>
    req<{ meta: ThreadMeta; entries: ThreadEntry[] }>(
      projectPath(projectId, `/threads/${encodeURIComponent(threadId)}`),
    ),

  /** Send one operator message into a live thread. 202 accepted -- the reply streams over
   *  `threadStreamUrl`, so (like `deleteChat`) there is no JSON body to parse on success. */
  async postThreadMessage(projectId: string, threadId: string, message: string): Promise<void> {
    const res = await fetch(projectPath(projectId, `/threads/${encodeURIComponent(threadId)}/message`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
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
  },

  /** Confirm a live thread's proposed plan -- 202 accepted, launches a run the same way
   *  `postChatConfirm` does. */
  async postThreadConfirm(projectId: string, threadId: string): Promise<void> {
    const res = await fetch(projectPath(projectId, `/threads/${encodeURIComponent(threadId)}/confirm`), {
      method: "POST",
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
  },

  /** Delete a thread (registry + persisted log). */
  async deleteThread(projectId: string, threadId: string): Promise<void> {
    const res = await fetch(projectPath(projectId, `/threads/${encodeURIComponent(threadId)}`), {
      method: "DELETE",
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
  },

  /** URL for the live thread's SSE connection -- the CALLER opens this with
   *  `new EventSource(...)`, same idiom as `chatStreamUrl`/`ciEventsUrl`. On connect the
   *  server replays the persisted `entries` before streaming live token + entry frames. */
  threadStreamUrl(projectId: string, threadId: string): string {
    return projectPath(projectId, `/threads/${encodeURIComponent(threadId)}/stream`);
  },
};
