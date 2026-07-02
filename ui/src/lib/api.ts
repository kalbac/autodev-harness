/**
 * Typed client over the daemon's read/write API seam (src/api/server.ts).
 * Same-origin in production (the daemon serves this bundle); Vite proxies the
 * same paths to the daemon in dev. The dashboard holds NO authoritative state —
 * every shape here mirrors a server response and is re-fetched on WS change.
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

/** Mirrors the orchestrator run manifest (`<stateDir>/runs/<runId>.json`). */
export interface RunManifest {
  runId: string;
  intent: string;
  taskIds: string[];
  at: number;
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

export const api = {
  getState: () => req<StateResponse>("/state"),
  getRuns: () => req<RunManifest[]>("/runs"),
  getRun: (id: string) => req<RunManifest>(`/runs/${encodeURIComponent(id)}`),
  getRuntimeFiles: (taskId: string) =>
    req<string[]>(`/tasks/${encodeURIComponent(taskId)}/runtime`),
  getEscalation: (id: string) => req<Escalation>(`/escalations/${encodeURIComponent(id)}`),

  /** Runtime files are raw text/json, not a JSON envelope — fetched as text. */
  async getRuntimeFile(taskId: string, name: string): Promise<{ text: string; truncated: boolean }> {
    const res = await fetch(
      `/tasks/${encodeURIComponent(taskId)}/runtime/${encodeURIComponent(name)}`,
    );
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return { text: await res.text(), truncated: res.headers.get("x-truncated") === "true" };
  },

  /** Structured A/B reply. `note` is context-only and NEVER executed (server-enforced). */
  postReply: (id: string, choice: "A" | "B", note: string) =>
    req<EscalationReply>(`/escalations/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice, note }),
    }),

  /** Launch a run: enqueue+trigger only (R1-safe, server-side). 202 accepted / 409 in-flight. */
  async postOrchestrate(intent: string): Promise<{ accepted: boolean; intent: string }> {
    const res = await fetch("/orchestrate", {
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
