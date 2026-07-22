import type { Task } from "./types.js";

export type QueueState = "pending" | "active" | "done" | "escalated" | "quarantine";

export interface BlackboardRepository {
  listTasks(state: QueueState): Promise<Task[]>;
  moveTask(id: string, from: QueueState, to: QueueState): Promise<void>;
  getAttempts(id: string): Promise<number>;
  setAttempts(id: string, n: number): Promise<void>;
  writeRuntimeFile(id: string, name: string, content: string): Promise<void>;
  readRuntimeFile(id: string, name: string): Promise<string | null>;
  /** Delete a runtime file (used to CLEAR a "latest value" artifact, e.g.
   *  `gate-feedback.md`, when the producing run has nothing to report). Must be
   *  idempotent for an already-absent file (no throw) — the write-or-clear caller
   *  does not track whether a previous run left one behind. Any OTHER failure
   *  (permission denied, etc.) must propagate rather than be folded into "already
   *  gone" — see `FileBlackboardRepository`'s implementation note. */
  removeRuntimeFile(id: string, name: string): Promise<void>;
  markDone(id: string, commitHash: string): Promise<void>; // append `<!-- committed: hash -->`
  appendDigest(line: string): Promise<void>;
  runtimeDir(id: string): string;
}
