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

/**
 * Progress hooks so a caller (CLI / dashboard) can narrate a corpus run case by case, and
 * persist what it has so far — a run takes minutes per case, so a crash on case 6 must not
 * cost the diagnostics of cases 1-5.
 *
 * CALLER CONTRACT: a hook MUST NOT throw. They are awaited so a hook's write completes
 * before the next case starts purging the state it describes, and that same `await` means
 * a rejection would abort the whole run — a reporting side-effect must never sink a
 * measurement. Callers doing IO here swallow their own failures (loudly).
 */
export interface CorpusRunHooks {
  onCaseStart?: (c: CorpusCase, index: number, total: number) => void | Promise<void>;
  onCaseDone?: (result: CorpusCaseResult, index: number, total: number) => void | Promise<void>;
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
    await hooks.onCaseStart?.(c, index, cases.length);
    let evidence: EvidenceRecord | null = null;
    let error: string | undefined;
    try {
      evidence = await executor.execute(c);
    } catch (err) {
      // KEEP the reason. `evidence === null` is still the only thing that makes the case
      // errored — the message is carried alongside so the run's diagnostics can say WHY
      // instead of leaving the operator to reproduce a 12-minute run to find out.
      error = err instanceof Error ? err.message : String(err);
    }
    const result: CorpusCaseResult = { case: c, evidence, ...(error !== undefined ? { error } : {}) };
    results.push(result);
    await hooks.onCaseDone?.(result, index, cases.length);
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
