import type { Task } from "./types.js";

export type QueueState = "pending" | "active" | "done" | "escalated" | "quarantine";

export interface BlackboardRepository {
  listTasks(state: QueueState): Promise<Task[]>;
  moveTask(id: string, from: QueueState, to: QueueState): Promise<void>;
  getAttempts(id: string): Promise<number>;
  setAttempts(id: string, n: number): Promise<void>;
  writeRuntimeFile(id: string, name: string, content: string): Promise<void>;
  readRuntimeFile(id: string, name: string): Promise<string | null>;
  markDone(id: string, commitHash: string): Promise<void>; // append `<!-- committed: hash -->`
  appendDigest(line: string): Promise<void>;
  runtimeDir(id: string): string;
}
