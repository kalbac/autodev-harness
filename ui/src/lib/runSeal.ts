import type { RunManifest, StateResponse } from "./api";
import type { Tone } from "./status";

/**
 * Best-effort verdict tone for a run's sidebar seal. The critic verdict is NOT
 * persisted per-run (gotcha [ui/verdict-not-persisted]) — so this is inferred
 * from the project's live queue state: a run whose task is currently active →
 * "working"; escalated → "uncertain"; quarantined → "broken"; otherwise the
 * optimistic "clean" (committed & merged). Only meaningful for the active
 * project (the only one whose state we fetch); collapsed projects don't show seals.
 */
export function runSeal(run: RunManifest, state: StateResponse | undefined): Tone {
  if (!state) return "clean";
  const ids = new Set(run.taskIds);
  const inQ = (q: keyof StateResponse["queues"]) => state.queues[q].some((t) => ids.has(t.id));
  if (inQ("active")) return "working";
  if (inQ("quarantine")) return "broken";
  if (inQ("escalated")) return "uncertain";
  return "clean";
}
