import type { ExecutionReport } from "./execution-report.js";
import type { QualificationReport } from "./qualification-report.js";

/**
 * Two renderers, one per document, deliberately NOT unified behind a generic
 * "render a report" helper: their whole purpose is that they say different things,
 * and a shared template is the first step back toward one mixed report (H5).
 */

export function renderExecutionReport(r: ExecutionReport): string {
  const c = r.completeness;
  const lines: string[] = [
    `# Harness Execution Report — ${r.run.runId}`,
    "",
    `> How the machine performed on this run. It says nothing about product quality.`,
    "",
    `**Intent:** ${r.run.intent}`,
    `**Evidence:** ${c.recorded} of ${c.total} task(s) recorded` +
      (c.absent + c.unreadable > 0 ? ` — ${c.absent} absent, ${c.unreadable} unreadable` : ""),
    "",
    "## Tasks",
    "",
    "| Task | Outcome | Commit | Rounds | Critic | Gate | Failed steps |",
    "|---|---|---|---|---|---|---|",
    ...r.tasks.map(
      (t) =>
        `| ${t.task_id} | ${t.outcome}${t.escalation_type ? ` (${t.escalation_type})` : ""} | ${t.commit ?? "—"} | ${t.rounds} | ` +
        `${t.critic ? `${t.critic.verdict} ${t.critic.confidence}` : "—"} | ${t.gate_decision ?? "—"} | ` +
        `${t.gate_failures.join(", ") || "—"} |`,
    ),
    "",
    "## Rollups",
    "",
    `- committed: ${r.rollups.committed} · escalated: ${r.rollups.escalated} · quarantined: ${r.rollups.quarantined}`,
    `- first-pass (committed with no retry): ${r.rollups.first_pass}`,
    `- escalations by type: ${Object.entries(r.rollups.escalations_by_type).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    `- tokens: worker ${r.rollups.tokens.worker_total}, critic ${r.rollups.tokens.critic_total}`,
    "",
  ];
  return lines.join("\n");
}

export function renderQualificationReport(r: QualificationReport): string {
  const p = r.profile === null ? "no profile attached" : `${r.profile.id}@${r.profile.version}`;
  const lines: string[] = [
    `# Product Qualification Report`,
    "",
    `**Profile:** ${p}`,
    `**Commits:** ${r.range.from}..${r.range.to} (${r.completeness.selected} of ${r.completeness.total} record(s) selected)`,
    `**Scope:** ${r.proven_on_change.length} check(s) proven on changed code, ` +
      `${r.proven_whole_product.length} across the whole product, ${r.not_proven.length} not proven.`,
    "",
    `> This report states what was checked and what was not. A check listed under`,
    `> "proven on change" was applied to the code a change introduced — not to the`,
    `> file it lives in, and not to the product.`,
    "",
    "## 1. Proven on change",
    "",
    ...(r.proven_on_change.length === 0
      ? ["_Nothing._", ""]
      : r.proven_on_change.map(
          (e) =>
            `- **${e.gate_id}** (${e.scope === "changed-lines" ? "the lines each change added" : "each changed file"}) — ` +
            `${e.commits.length} commit(s), ${e.files.length} file(s)`,
        ).concat("")),
    "## 2. Proven whole-product",
    "",
    ...(r.proven_whole_product.length === 0
      ? ["_Nothing._", ""]
      : r.proven_whole_product.map((e) => `- **${e.gate_id}** — ${e.commits.length} commit(s)`).concat("")),
    "## 3. Not proven",
    "",
    ...(r.not_proven.length === 0
      ? ["_Nothing recorded — which for this section is itself suspicious._", ""]
      : r.not_proven.map((e) => `- \`${e.kind}\` **${e.subject}** — ${e.detail}`).concat("")),
  ];
  return lines.join("\n");
}
