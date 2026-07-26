import type { CorpusCaseResult } from "./corpus-metrics.js";
import { aggregateCorpus } from "./corpus-metrics.js";
import type { EvidenceRecord } from "../report/evidence-types.js";

/**
 * The machine-readable companion to the Corpus Report: every case's RAW `EvidenceRecord`,
 * the reason an errored case errored, and where its blackboard artifacts were archived.
 *
 * The markdown report answers "did the harness do the right thing"; it deliberately says
 * nothing about WHY, and after the first live run (s56) that meant every failed case cost
 * a manual dig through a `conductor.log` whose `runtime/` had already been purged. This
 * file is the other half: the report to read, this to debug from.
 *
 * It is a PROJECTION, never a second truth (Principle 11). Nothing reads it back into a
 * metric — the verdicts here are re-derived from the same `aggregateCorpus` the report
 * uses, so the two cannot disagree, and the evidence is copied verbatim rather than
 * summarized so a later question can be answered without re-running anything.
 */
export const CORPUS_RUN_MANIFEST_SCHEMA_VERSION = 1;

/** Filename written inside the run's artifacts directory. */
export const CORPUS_RUN_MANIFEST_FILE = "corpus-run.json";

/** Run-level facts the results themselves do not carry. */
export interface CorpusRunContext {
  /** ISO-8601 timestamp, supplied by the caller (this module holds no clock). */
  generated_at: string;
  target_repo: string;
  /** The immutable baseline sha every case reset to. */
  baseline: string;
  corpus_dir: string;
  artifacts_dir: string;
  /** How many cases the run intends to execute, so a manifest written mid-run is visibly
   *  incomplete rather than looking like a short corpus. */
  total_cases: number;
}

export interface CorpusRunManifestCase {
  id: string;
  type: string;
  adversarial: boolean;
  expected: { outcome: string; escalation_type: string | null };
  actual: { outcome: string; escalation_type: string | null };
  passed: boolean;
  reason: string;
  /** The executor's failure message when the case produced no evidence; null otherwise. */
  error: string | null;
  /** This case's archive directory, relative to `artifacts_dir`. Named unconditionally:
   *  archiving is best-effort, so the directory may be absent or partial — the run's
   *  `conductor.log` carries a WARN when it is, and inventing an "archived: true" field
   *  the writer cannot honestly answer would be worse than a path the reader can stat. */
  artifacts: string;
  /** The record verbatim, or null for an errored case. */
  evidence: EvidenceRecord | null;
}

export interface CorpusRunManifest {
  schema: number;
  generated_at: string;
  target_repo: string;
  baseline: string;
  corpus_dir: string;
  artifacts_dir: string;
  cases_total: number;
  cases_completed: number;
  /** True while cases remain — the manifest is rewritten after every case so a run that
   *  dies on case 6 still leaves the diagnostics of cases 1-5 on disk. */
  partial: boolean;
  cases: CorpusRunManifestCase[];
}

/**
 * Fold the results executed SO FAR into a manifest. Pure and total: safe to call after
 * every case, and safe to call with an empty result set (a run that died before its first
 * case still writes a manifest saying exactly that).
 */
export function buildCorpusRunManifest(ctx: CorpusRunContext, results: CorpusCaseResult[]): CorpusRunManifest {
  // Re-derive the verdicts from the SAME aggregator the report renders from, rather than
  // re-implementing the comparison here: two independent copies of "did this case pass"
  // is exactly how a projection starts disagreeing with the thing it projects.
  const verdicts = new Map(aggregateCorpus(results).cases.map((v) => [v.id, v]));

  const cases: CorpusRunManifestCase[] = results.map((r) => {
    const v = verdicts.get(r.case.id);
    /* c8 ignore next -- `aggregateCorpus` emits one verdict per result, keyed by the id */
    if (v === undefined) throw new Error(`corpus manifest: no verdict for case '${r.case.id}'`);
    return {
      id: r.case.id,
      type: r.case.type,
      adversarial: r.case.adversarial,
      expected: v.expected,
      actual: v.actual,
      passed: v.passed,
      reason: v.reason,
      error: r.error ?? null,
      artifacts: r.case.id,
      evidence: r.evidence,
    };
  });

  const completed = cases.length;
  return {
    schema: CORPUS_RUN_MANIFEST_SCHEMA_VERSION,
    generated_at: ctx.generated_at,
    target_repo: ctx.target_repo,
    baseline: ctx.baseline,
    corpus_dir: ctx.corpus_dir,
    artifacts_dir: ctx.artifacts_dir,
    cases_total: ctx.total_cases,
    cases_completed: completed,
    partial: completed < ctx.total_cases,
    cases,
  };
}

/** Serialize the manifest for writing — indented, newline-terminated, so it diffs and
 *  greps like every other artifact this harness writes. */
export function renderCorpusRunManifest(manifest: CorpusRunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
