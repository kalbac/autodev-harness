import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlackboardRepository, QueueState } from "../blackboard/repository.js";
import type { Task } from "../blackboard/types.js";
import type { Logger } from "../util/log.js";
import { writeTaskToPending, type WriteTaskDeps } from "./enqueue.js";
import type { TaskSpec } from "./task-spec.js";

const ALL_QUEUE_STATES: QueueState[] = ["pending", "active", "done", "escalated", "quarantine"];

/**
 * The full orchestrator capability surface. R1 boundary: this interface is
 * the ONLY thing an orchestrator agent is allowed to touch — no direct repo,
 * no gate, no worktree, no git. `enqueue`/`read`/`report` are implemented
 * here (no open design fork). `trigger` is an INTERFACE MEMBER ONLY — its
 * implementation is blocked on an operator-approved design (fork B/C).
 */
export interface OrchestratorCapabilities {
  enqueue(spec: TaskSpec): Promise<{ id: string; path: string }>;
  trigger(opts?: { once?: boolean; maxIterations?: number }): Promise<unknown>; // impl deferred (fork B/C) — interface only
  read: {
    queues(): Promise<Record<QueueState, Task[]>>;
    runtimeReport(id: string, name: string): Promise<string | null>;
    digestTail(): Promise<string>;
  };
  report(entry: { level: string; message: string }): Promise<void>;
}

/** Number of trailing lines `read.digestTail()` returns (undocumented in the
 *  spec beyond "the digest tail" — chosen to keep an orchestrator prompt's
 *  context bounded even if digest.md grows large over a long session). */
const DIGEST_TAIL_LINES = 50;

/**
 * `BlackboardRepository` exposes no direct digest-read method (frozen seam),
 * only `appendDigest` + `runtimeDir(id)`. `runtimeDir(id)` deterministically
 * returns `<repoRoot>/<stateDir>/runtime/<id>` (see file-repository.ts), so
 * walking up two segments from any (non-filesystem-touching) call recovers
 * `<repoRoot>/<stateDir>`, matching `appendDigest`'s own path construction.
 */
function digestPath(repo: BlackboardRepository): string {
  const runtimeDirForProbeId = repo.runtimeDir("__digest_tail_probe__");
  return join(dirname(dirname(runtimeDirForProbeId)), "digest.md");
}

/** Read-only: wraps `repo.listTasks` (looped across all `QueueState`s),
 *  `repo.readRuntimeFile`, and a bounded tail of `digest.md`. */
export function createReadCapability(repo: BlackboardRepository): OrchestratorCapabilities["read"] {
  return {
    async queues(): Promise<Record<QueueState, Task[]>> {
      const entries = await Promise.all(
        ALL_QUEUE_STATES.map(async (state) => [state, await repo.listTasks(state)] as const),
      );
      return Object.fromEntries(entries) as Record<QueueState, Task[]>;
    },
    async runtimeReport(id: string, name: string): Promise<string | null> {
      return repo.readRuntimeFile(id, name);
    },
    async digestTail(): Promise<string> {
      const path = digestPath(repo);
      if (!existsSync(path)) return "";
      const content = await readFile(path, "utf8");
      const lines = content.split("\n");
      if (lines.length <= DIGEST_TAIL_LINES) return content;
      return lines.slice(-DIGEST_TAIL_LINES).join("\n");
    },
  };
}

/**
 * Appends a `[orchestrator] `-prefixed line to the shared digest (also
 * written by the conductor — the prefix keeps digest.md parseable per-writer)
 * AND logs via the injected logger. Never throws on its own: `appendDigest`'s
 * I/O failure mode is inherited from the repo implementation, not masked here.
 */
export function createReportCapability(repo: BlackboardRepository, log: Logger): OrchestratorCapabilities["report"] {
  return async (entry: { level: string; message: string }): Promise<void> => {
    // Collapse any CR/LF runs before writing to the digest so a crafted
    // `level`/`message` can never forge extra digest lines (each digest
    // entry must stay exactly one line). The raw, unflattened message is
    // still passed to the injected logger below.
    const flatLevel = entry.level.replace(/[\r\n]+/g, " ");
    const flatMessage = entry.message.replace(/[\r\n]+/g, " ");
    await repo.appendDigest(`[orchestrator] [${flatLevel}] ${flatMessage}`);
    log(entry.level, entry.message);
  };
}

/** Closure over `writeTaskToPending` — the only way an orchestrator can add work. */
export function createEnqueueCapability(deps: WriteTaskDeps): OrchestratorCapabilities["enqueue"] {
  return (spec: TaskSpec) => writeTaskToPending(spec, deps);
}
