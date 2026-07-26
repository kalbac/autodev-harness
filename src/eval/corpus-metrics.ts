import type { CorpusCase } from "./corpus-case.js";
import type { EvidenceRecord } from "../report/evidence-types.js";

/** One executed corpus case: the case as declared + the evidence the harness produced for
 *  it (null when the case failed to run at all — no record was written). */
export interface CorpusCaseResult {
  case: CorpusCase;
  evidence: EvidenceRecord | null;
  /**
   * Why the case produced no evidence, when the executor threw. Absent on a case that ran.
   *
   * Diagnostics only — no metric reads it, and `evidence === null` remains the single fact
   * that makes a case errored. It exists because the runner used to discard the executor's
   * message entirely, so a corpus report could say "the case failed to run" while the only
   * copy of the reason had already been swallowed by the catch.
   */
  error?: string;
}

/** Per-case verdict: did the harness's ACTUAL outcome match what the case EXPECTED. */
export interface CorpusCaseVerdict {
  id: string;
  type: CorpusCase["type"];
  expected: { outcome: "committed" | "escalated"; escalation_type: string | null };
  actual: { outcome: EvidenceRecord["outcome"] | "errored"; escalation_type: string | null };
  passed: boolean;
  reason: string;
}

/** Corpus-level metrics — the numbers that make the harness's value provable rather than
 *  asserted. Rates are `null` (NOT 0) when no case exercises them, so "not measured" never
 *  reads as "perfect"/"zero" (Principle 10, and the same fail-closed instinct as the
 *  evidence ledger's nullable finding counts). */
export interface CorpusMetrics {
  total: number;
  passed: number;
  failed: number;
  /** Cases that produced no evidence record at all (also counted as a per-case failure). */
  errored: number;
  /** Of the GOOD cases (expected `committed`), the fraction that committed on the first
   *  pass (rounds === 0). Null when there are no committed-expected cases. */
  first_pass_commit_rate: number | null;
  /** Average `rounds` across cases that actually committed. Null when none committed. */
  avg_rounds_to_commit: number | null;
  /** Of the ADVERSARIAL cases (expected `escalated`), the fraction that committed instead
   *  of being caught — an escaped defect. Null when there are no adversarial cases. This is
   *  the harness's catching-power metric; higher is worse. */
  escaped_defect_rate: number | null;
  /** Histogram of the escalation type across every case that escalated. */
  escalations_by_type: Record<string, number>;
  /** Cases that ended parked awaiting the operator (outcome `escalated`). */
  human_interventions: number;
  /** Sum of (ended_at - started_at) in ms across cases that produced a record. */
  total_wall_clock_ms: number;
  /** Summed token totals across cases that produced a record (never $ — token count only). */
  tokens: { worker_total: number; critic_total: number };
  cases: CorpusCaseVerdict[];
}

function evaluateCase(result: CorpusCaseResult): CorpusCaseVerdict {
  const expected = result.case.expected;
  const base = {
    id: result.case.id,
    type: result.case.type,
    expected: { outcome: expected.outcome, escalation_type: expected.escalation_type },
  };

  if (result.evidence === null) {
    return {
      ...base,
      actual: { outcome: "errored", escalation_type: null },
      passed: false,
      reason: "no evidence record — the case failed to run",
    };
  }

  const ev = result.evidence;
  const actualEscType = ev.escalation?.type ?? null;
  const actual = { outcome: ev.outcome, escalation_type: actualEscType };

  if (expected.outcome === "committed") {
    const passed = ev.outcome === "committed";
    return {
      ...base,
      actual,
      passed,
      reason: passed ? "committed as expected" : `expected a commit but the harness ${ev.outcome} the task`,
    };
  }

  // expected.outcome === "escalated" (must-be-caught or genuinely-ambiguous case)
  if (ev.outcome !== "escalated") {
    const label = result.case.adversarial ? "escaped defect" : "unexpected commit";
    return {
      ...base,
      actual,
      passed: false,
      reason: `expected an escalation but the harness ${ev.outcome} the task (${label})`,
    };
  }
  if (expected.escalation_type !== null && actualEscType !== expected.escalation_type) {
    return {
      ...base,
      actual,
      passed: false,
      reason: `escalated as '${actualEscType}', expected '${expected.escalation_type}'`,
    };
  }
  return { ...base, actual, passed: true, reason: "escalated as expected" };
}

/**
 * Fold executed corpus-case results into corpus-level metrics. Pure — no clock, no IO — so
 * it is fully deterministic and testable in isolation from a real harness run.
 */
export function aggregateCorpus(results: CorpusCaseResult[]): CorpusMetrics {
  const cases = results.map(evaluateCase);

  const committedExpected = results.filter((r) => r.case.expected.outcome === "committed");
  const firstPassCommits = committedExpected.filter(
    (r) => r.evidence?.outcome === "committed" && r.evidence.rounds === 0,
  ).length;

  const committedRecords = results.filter((r) => r.evidence?.outcome === "committed");
  // Escaped defects are measured ONLY over adversarial cases (a planted defect that must be
  // caught). A genuinely-ambiguous escalated-expected case that commits is a per-case failure
  // but NOT an escaped defect, so it must not inflate this catching-power metric.
  const adversarial = results.filter((r) => r.case.adversarial);
  const escapedDefects = adversarial.filter((r) => r.evidence?.outcome === "committed").length;

  const escalationsByType: Record<string, number> = {};
  let humanInterventions = 0;
  let totalWallClockMs = 0;
  const tokens = { worker_total: 0, critic_total: 0 };

  for (const r of results) {
    const ev = r.evidence;
    if (ev === null) continue;
    if (ev.outcome === "escalated") {
      humanInterventions += 1;
      const t = ev.escalation?.type;
      if (t !== undefined && t !== null) escalationsByType[t] = (escalationsByType[t] ?? 0) + 1;
    }
    // Guard a malformed/backwards timestamp pair: only a finite, non-negative span counts,
    // so an unparseable date (NaN) or ended<started never poisons the total.
    const spanMs = Date.parse(ev.ended_at) - Date.parse(ev.started_at);
    if (Number.isFinite(spanMs) && spanMs > 0) totalWallClockMs += spanMs;
    if (ev.tokens !== null) {
      tokens.worker_total += ev.tokens.worker_total;
      tokens.critic_total += ev.tokens.critic_total;
    }
  }

  const passed = cases.filter((c) => c.passed).length;

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    errored: results.filter((r) => r.evidence === null).length,
    first_pass_commit_rate: committedExpected.length === 0 ? null : firstPassCommits / committedExpected.length,
    avg_rounds_to_commit:
      committedRecords.length === 0
        ? null
        : committedRecords.reduce((s, r) => s + (r.evidence?.rounds ?? 0), 0) / committedRecords.length,
    escaped_defect_rate: adversarial.length === 0 ? null : escapedDefects / adversarial.length,
    escalations_by_type: escalationsByType,
    human_interventions: humanInterventions,
    total_wall_clock_ms: totalWallClockMs,
    tokens,
    cases,
  };
}
