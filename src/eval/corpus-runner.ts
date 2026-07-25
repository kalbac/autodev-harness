import type { CorpusCase } from "./corpus-case.js";
import type { EvidenceRecord } from "../report/evidence-types.js";
import type { CorpusCaseResult, CorpusMetrics } from "./corpus-metrics.js";
import { aggregateCorpus } from "./corpus-metrics.js";

/**
 * Executes ONE case's intent through the harness and returns the `EvidenceRecord` it
 * produced, or `null` when the case could not produce one. This is the seam between the
 * corpus's deterministic orchestration (here) and the heavy, environment-bound work of
 * actually running a case: the real executor (Phase 2) seeds a repo and drives the headless
 * conductor; tests inject a scripted executor so the runner is deterministic.
 */
export interface CaseExecutor {
  execute(c: CorpusCase): Promise<EvidenceRecord | null>;
}

/** Progress hooks so a caller (CLI / dashboard) can narrate a corpus run case by case. */
export interface CorpusRunHooks {
  onCaseStart?: (c: CorpusCase, index: number, total: number) => void;
  onCaseDone?: (result: CorpusCaseResult, index: number, total: number) => void;
}

/**
 * Run every case through the executor SEQUENTIALLY, pairing each with its evidence. Cases
 * run one at a time on purpose: a real corpus run drives real conductors over real
 * worktrees/branches, which would contend under parallelism. An executor that THROWS for a
 * case yields a `null`-evidence result (the aggregator counts it as errored) rather than
 * aborting the whole corpus run — one broken case must not sink the measurement.
 */
export async function runCorpus(
  cases: CorpusCase[],
  executor: CaseExecutor,
  hooks: CorpusRunHooks = {},
): Promise<CorpusCaseResult[]> {
  const results: CorpusCaseResult[] = [];
  for (let index = 0; index < cases.length; index++) {
    const c = cases[index]!;
    hooks.onCaseStart?.(c, index, cases.length);
    let evidence: EvidenceRecord | null;
    try {
      evidence = await executor.execute(c);
    } catch {
      evidence = null;
    }
    const result: CorpusCaseResult = { case: c, evidence };
    results.push(result);
    hooks.onCaseDone?.(result, index, cases.length);
  }
  return results;
}

/** Convenience: run the corpus and fold the results into metrics in one call. */
export async function evaluateCorpus(
  cases: CorpusCase[],
  executor: CaseExecutor,
  hooks?: CorpusRunHooks,
): Promise<{ results: CorpusCaseResult[]; metrics: CorpusMetrics }> {
  const results = await runCorpus(cases, executor, hooks);
  return { results, metrics: aggregateCorpus(results) };
}
