/**
 * The single status/verdict tone vocabulary — every colored dot, pill, and
 * column header speaks this language, so the operator learns it once and reads
 * the whole dashboard at a glance. Color is rare and meaningful.
 */
import type { QueueState, Task } from "./api";

export type Tone = "working" | "uncertain" | "broken" | "clean" | "idle" | "accent";

/** CSS var name for a tone — used inline via color-mix in StatusPill / dots. */
export const toneVar: Record<Tone, string> = {
  working: "var(--color-working)",
  uncertain: "var(--color-uncertain)",
  broken: "var(--color-broken)",
  clean: "var(--color-clean)",
  idle: "var(--color-subtle)",
  accent: "var(--color-accent)",
};

export interface QueueMeta {
  state: QueueState;
  label: string;
  tone: Tone;
  /** Operator-facing gloss under the column title. */
  hint: string;
}

/** Column order + meaning (board lens). `active` and `escalated` lead — that's
 *  where the operator's attention belongs. */
export const QUEUE_META: Record<QueueState, QueueMeta> = {
  active: { state: "active", label: "Active", tone: "working", hint: "Agents working now" },
  escalated: { state: "escalated", label: "Needs you", tone: "uncertain", hint: "Gate refused — decide" },
  pending: { state: "pending", label: "Pending", tone: "idle", hint: "Queued" },
  quarantine: { state: "quarantine", label: "Quarantine", tone: "broken", hint: "Blocked / poisoned" },
  done: { state: "done", label: "Done", tone: "clean", hint: "Committed & merged" },
};

/** Critic verdict → tone. */
export function verdictTone(verdict: string): Tone {
  switch (verdict) {
    case "clean":
      return "clean";
    case "broken":
      return "broken";
    case "uncertain":
      return "uncertain";
    default:
      return "idle";
  }
}

/** True when a task carries a contract-zone / guard risk worth flagging on its
 *  card — the "never merge bullshit" surface starts here. */
export function isGuarded(task: Task): boolean {
  return task.touches_contract_zone || task.writes_guard || task.needs_guard;
}
