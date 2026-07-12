import type { Milestone } from "./activity-map.js";

export interface PendingMilestone { at: number; milestone: Milestone; }
const TERMINAL = new Set(["run_finished", "task_escalated"]);

export function coalesceMilestones(pending: PendingMilestone[], now: number, windowMs: number): { fire: PendingMilestone[]; keep: PendingMilestone[] } {
  if (pending.length === 0) return { fire: [], keep: [] };
  const hasTerminal = pending.some((p) => TERMINAL.has(p.milestone.kind));
  const oldest = Math.min(...pending.map((p) => p.at));
  if (hasTerminal || now - oldest >= windowMs) return { fire: pending, keep: [] };
  return { fire: [], keep: pending };
}
