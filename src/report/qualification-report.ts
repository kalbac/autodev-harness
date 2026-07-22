import type { EvidenceSlot } from "./evidence-store.js";

export interface CommitRange {
  from: string;
  to: string;
  /** The commit hashes in `from..to`, as `git rev-list` reports them. */
  commits: string[];
}

export interface ProvenEntry {
  gate_id: string;
  scope: "changed-lines" | "changed-files" | "whole-project";
  commits: string[];
  files: string[];
}

export interface NotProvenEntry {
  kind: "skipped-gate" | "unchecked-acceptance" | "pre-existing-debt" | "missing-evidence" | "standing-residual";
  subject: string;
  detail: string;
}

export interface QualificationReport {
  kind: "product-qualification";
  /**
   * Every DISTINCT profile the selected evidence was judged under — a list, not a
   * single value, because a commit range can legitimately span a profile version
   * bump (the WordPress profile went `@1` -> `@2` inside one week). Naming only one
   * of them would attribute work to a ruleset that never judged it, which is the
   * same overclaim this report exists to avoid. Empty means no profile was attached.
   */
  profiles: { id: string; version: number }[];
  range: CommitRange;
  completeness: { total: number; selected: number; absent: number; unreadable: number };
  proven_on_change: ProvenEntry[];
  proven_whole_product: ProvenEntry[];
  not_proven: NotProvenEntry[];
}

/**
 * The residual this harness cannot close and therefore states outright: a profile's
 * gates run `vendor/bin/<tool>`, and `vendor` comes from the project's own manifest,
 * so the analyzer itself is project-controlled. Named rather than checked, because
 * no mechanical rule separates "a project script" from "a project binary"
 * (docs/CURRENT-STATE.md, open questions).
 */
const STANDING_RESIDUALS: NotProvenEntry[] = [
  {
    kind: "standing-residual",
    subject: "analyzer toolchain",
    detail:
      "A profile gate runs a binary installed by the project's own manifest, so the analyzer itself is project-controlled. Not checked by this harness.",
  },
];

/** Distinct `id@version` pairs, in first-seen order. */
function distinctProfiles(records: { profile: { id: string; version: number } | null }[]): { id: string; version: number }[] {
  const seen = new Set<string>();
  const out: { id: string; version: number }[] = [];
  for (const r of records) {
    if (r.profile === null) continue;
    const key = `${r.profile.id}@${r.profile.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.profile);
  }
  return out;
}

/**
 * PRODUCT ONLY. Never reads tokens, rounds, or attempts (H5) — those are execution
 * diagnostics, and mixing them here is precisely what the two-report split forbids.
 *
 * `not_proven` is the load-bearing section: everything the green gates did NOT
 * establish. A report whose third section is short is a report that has not looked.
 */
export function buildQualificationReport(range: CommitRange, slots: EvidenceSlot[]): QualificationReport {
  const inRange = new Set(range.commits);
  const records = slots.flatMap((s) => (s.state === "ok" ? [s.record] : []));
  const selected = records.filter((r) => r.commit !== null && inRange.has(r.commit));

  const byGate = new Map<string, ProvenEntry>();
  const notProven: NotProvenEntry[] = [];

  for (const r of selected) {
    for (const g of r.profile_gates) {
      if (g.status === "skipped") {
        notProven.push({ kind: "skipped-gate", subject: g.id, detail: g.skip_reason ?? "(no reason recorded)" });
        continue;
      }
      if (g.status !== "green") {
        // A red gate never landed a commit, so it cannot appear as proof. It is
        // not "not proven" either — the change simply did not pass. Nothing to add.
        continue;
      }
      const key = `${g.id}::${g.scope}`;
      const entry = byGate.get(key) ?? { gate_id: g.id, scope: g.scope, commits: [], files: [] };
      if (r.commit !== null && !entry.commits.includes(r.commit)) entry.commits.push(r.commit);
      for (const f of g.files) if (!entry.files.includes(f)) entry.files.push(f);
      byGate.set(key, entry);

      const debt = g.findings === null ? 0 : g.findings.total - g.findings.in_diff;
      if (debt > 0) {
        notProven.push({
          kind: "pre-existing-debt",
          subject: g.id,
          detail: `${debt} finding(s) outside the judged lines remain unaddressed in ${g.files.join(", ") || "the scanned files"}`,
        });
      }
    }
  }

  // Acceptance is reported for EVERY record, selected or not: the operator asked
  // for it, and a task that escalated without landing still leaves it unproven.
  for (const r of records) {
    if (r.declared.success_commands.length > 0) continue;
    for (const a of r.declared.acceptance) {
      notProven.push({
        kind: "unchecked-acceptance",
        subject: a,
        detail: `declared by task ${r.task_id}; no success_command covers it, so nothing machine-checked it`,
      });
    }
  }

  for (const s of slots) {
    if (s.state === "absent") {
      notProven.push({ kind: "missing-evidence", subject: s.taskId, detail: "no evidence record was written for this task" });
    } else if (s.state === "unreadable") {
      notProven.push({ kind: "missing-evidence", subject: s.taskId, detail: `evidence unreadable: ${s.detail}` });
    }
  }

  notProven.push(...STANDING_RESIDUALS);

  const entries = [...byGate.values()];
  return {
    kind: "product-qualification",
    profiles: distinctProfiles(selected.length > 0 ? selected : records),
    range,
    completeness: {
      total: slots.length,
      selected: selected.length,
      absent: slots.filter((s) => s.state === "absent").length,
      unreadable: slots.filter((s) => s.state === "unreadable").length,
    },
    proven_on_change: entries.filter((e) => e.scope !== "whole-project"),
    proven_whole_product: entries.filter((e) => e.scope === "whole-project"),
    not_proven: notProven,
  };
}
