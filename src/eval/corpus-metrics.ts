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
  /**
   * Cases that produced a record (`total - errored`) — the DENOMINATOR for
   * `first_pass_commit_rate` and `escaped_defect_rate` below, surfaced explicitly rather
   * than left for a reader to compute, so a shrunk denominator is a fact in the shape of
   * this type, not something the report has to remember to mention.
   *
   * Why the rates exclude an errored case at all: an `errored` case (no decomposition, 0
   * tasks enqueued, an unreachable critic — no evidence record was ever written) is an
   * INSTRUMENT failure, not a harness verdict. Counting it in a rate's denominator makes
   * "the instrument broke on 2 of 7 cases" arithmetically indistinguishable from "the
   * harness failed 2 of 7 cases", and an intermittent instrument failure would move the
   * metric between two runs of the identical harness on its own — which defeats the
   * corpus's whole purpose (comparing runs). An errored case is still counted (see
   * `errored` above) and still fails the pass bar as a per-case FAIL (`evaluatePassBar` in
   * `eval-cli.ts` — `failed > 0`); only the two RATES change denominator.
   *
   * The honest residual, named rather than papered over: an absent evidence record CAN in
   * principle be a genuine harness defect (the conductor failing to persist one it should
   * have), not only a broken instrument — excluding it from the rate could in that case
   * mask a real regression. That is exactly why every errored case is listed BY NAME with
   * its reason in the report (`renderCorpusReport`) rather than folded into a bare number:
   * the exclusion is visible and inspectable, never silent.
   */
  measured: number;
  /** Of the GOOD cases (expected `committed`) that were MEASURED, the fraction that
   *  committed on the first pass (rounds === 0). Null when there are no measured
   *  committed-expected cases. */
  first_pass_commit_rate: number | null;
  /** Average `rounds` across cases that actually committed. Null when none committed. */
  avg_rounds_to_commit: number | null;
  /** Of the ADVERSARIAL cases (expected `escalated`) that were MEASURED, the fraction that
   *  committed instead of being caught — an escaped defect. Null when there are no
   *  measured adversarial cases. This is the harness's catching-power metric; higher is
   *  worse. */
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
      // The real cause, when the executor's throw carried one (it always does in
      // production — `runCorpus` captures it via `safeErrorText`), not a boilerplate
      // stand-in: the report's loud "errored (instrument)" block names each case by this
      // exact reason (Fix 4), and it would otherwise have nothing to name.
      reason:
        result.error !== undefined
          ? `no evidence record — ${result.error}`
          : "no evidence record — the case failed to run",
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

  // The two RATE denominators below are drawn from `measured` (a record was produced),
  // never from `results` directly -- an errored case (no record at all) is an instrument
  // failure, not a harness verdict, and must not sit in either denominator (Fix 4 / see
  // `CorpusMetrics.measured`'s doc comment for the full rationale and the named residual).
  const measured = results.filter((r) => r.evidence !== null);

  const committedExpected = measured.filter((r) => r.case.expected.outcome === "committed");
  const firstPassCommits = committedExpected.filter(
    (r) => r.evidence!.outcome === "committed" && r.evidence!.rounds === 0,
  ).length;

  const committedRecords = measured.filter((r) => r.evidence!.outcome === "committed");
  // Escaped defects are measured ONLY over adversarial cases (a planted defect that must be
  // caught). A genuinely-ambiguous escalated-expected case that commits is a per-case failure
  // but NOT an escaped defect, so it must not inflate this catching-power metric.
  const adversarial = measured.filter((r) => r.case.adversarial);
  const escapedDefects = adversarial.filter((r) => r.evidence!.outcome === "committed").length;

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
    measured: measured.length,
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
