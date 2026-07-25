import type { CorpusMetrics } from "./corpus-metrics.js";

/** A rate in [0,1] as a percent, or `n/a` when it was not measured (null). Never renders a
 *  null as `0%` — "not measured" must not read as "perfect"/"none". */
function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 1000) / 10}%`;
}

function num(rate: number | null): string {
  return rate === null ? "n/a" : String(Math.round(rate * 100) / 100);
}

/** Escape a value for a markdown table cell so a `|` or a newline in the (authored) text
 *  cannot break the table structure. */
function cell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/**
 * Render corpus-level metrics as a self-contained markdown Corpus Report. Pure (metrics in,
 * string out) — deterministic and testable without a harness run. This is the corpus-level
 * report, distinct from the per-run Harness Execution / Product Qualification reports: it
 * measures the harness's behaviour ACROSS a curated set of cases (does it commit good work
 * and catch bad work), which is what makes its value provable rather than asserted. Token
 * COUNTS only — never a dollar cost (a deliberate product rule).
 */
export function renderCorpusReport(m: CorpusMetrics): string {
  const lines: string[] = [];

  lines.push("# Corpus Report");
  lines.push("");
  lines.push(`**${m.passed}/${m.total} cases passed** (harness outcome matched the case's expectation)` +
    (m.errored > 0 ? ` — ${m.errored} errored (no record).` : "."));
  lines.push("");

  lines.push("## Aggregate metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| First-pass commit rate | ${pct(m.first_pass_commit_rate)} |`);
  lines.push(`| Avg rounds to commit | ${num(m.avg_rounds_to_commit)} |`);
  lines.push(`| Escaped-defect rate | ${pct(m.escaped_defect_rate)} |`);
  lines.push(`| Human interventions (parked) | ${m.human_interventions} |`);
  lines.push(`| Total wall-clock | ${(m.total_wall_clock_ms / 1000).toFixed(1)}s |`);
  lines.push(`| Tokens (worker / critic) | ${m.tokens.worker_total} / ${m.tokens.critic_total} |`);
  lines.push("");

  const escTypes = Object.keys(m.escalations_by_type).sort();
  if (escTypes.length > 0) {
    lines.push("## Escalations by type");
    lines.push("");
    for (const t of escTypes) {
      lines.push(`- \`${t}\`: ${m.escalations_by_type[t]}`);
    }
    lines.push("");
  }

  lines.push("## Cases");
  lines.push("");
  lines.push("| Case | Type | Expected | Actual | Result | Reason |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of m.cases) {
    const expected = c.expected.escalation_type
      ? `${c.expected.outcome} (${c.expected.escalation_type})`
      : c.expected.outcome;
    const actual = c.actual.escalation_type ? `${c.actual.outcome} (${c.actual.escalation_type})` : c.actual.outcome;
    const result = c.passed ? "PASS" : "FAIL";
    lines.push(`| ${cell(c.id)} | ${cell(c.type)} | ${cell(expected)} | ${cell(actual)} | ${result} | ${cell(c.reason)} |`);
  }
  lines.push("");

  return lines.join("\n");
}
