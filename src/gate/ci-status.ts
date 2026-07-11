import type { AgentCiEvent } from "./agent-ci-events.js";

export interface CiStatusSummary {
  phase: "running" | "passed" | "failed";
  workflow: string | null;
  steps: { done: number; total: number };
  failedSteps: string[];
}

/** Fold one event into the running summary (used to rewrite agent-ci-status.json cheaply). */
export function foldCiStatus(prev: CiStatusSummary, workflow: string, ev: AgentCiEvent): CiStatusSummary {
  const next: CiStatusSummary = {
    phase: prev.phase,
    workflow: workflow,
    steps: { ...prev.steps },
    failedSteps: [...prev.failedSteps],
  };
  switch (ev.kind) {
    case "step-start":
      next.steps.total = Math.max(next.steps.total, ev.index + 1);
      break;
    case "step-finish":
      next.steps.total = Math.max(next.steps.total, ev.index + 1);
      next.steps.done = Math.max(next.steps.done, ev.index + 1);
      if (/^(failed|failure|error)$/i.test(ev.status)) next.failedSteps.push(ev.step);
      break;
    case "run-finish":
      next.phase = /^(passed|success|succeeded)$/i.test(ev.status) ? "passed" : "failed";
      break;
    default:
      break;
  }
  return next;
}

export function initialCiStatus(): CiStatusSummary {
  return { phase: "running", workflow: null, steps: { done: 0, total: 0 }, failedSteps: [] };
}
