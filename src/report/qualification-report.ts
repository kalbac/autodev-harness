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

  // A SKIPPED gate is reported from EVERY record, selected or not (H2). "phpcs was
  // unavailable" is a fact about the qualification ATTEMPT, and it stays true whether
  // or not the task went on to land a commit -- reading skips only from the selected
  // records hid every skip on an escalated or quarantined task, which is exactly the
  // unreported bound that reads as coverage. De-duplicated by id + reason so one skip
  // repeated across ten tasks is one line, not ten.
  const seenSkips = new Set<string>();
  for (const r of records) {
    for (const g of r.profile_gates) {
      if (g.status !== "skipped") continue;
      const reason = g.skip_reason ?? "(no reason recorded)";
      const key = `${g.id}::${reason}`;
      if (seenSkips.has(key)) continue;
      seenSkips.add(key);
      notProven.push({ kind: "skipped-gate", subject: g.id, detail: reason });
    }
  }

  for (const r of selected) {
    for (const g of r.profile_gates) {
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

      const where = g.files.join(", ") || "the scanned files";
      const counts = g.findings;
      if (counts !== null && counts.total === null) {
        // NOT MEASURED is not zero debt. The tool's pre-filter count was never
        // taken, so the difference that IS the pre-existing debt cannot be
        // computed -- and a green gate silently standing in for "nothing else is
        // wrong with this file" is the overclaim this section exists to block.
        notProven.push({
          kind: "pre-existing-debt",
          subject: g.id,
          detail: `the tool's finding count before diff-filtering was never measured, so the pre-existing debt in ${where} is UNKNOWN -- not zero`,
        });
      } else if (counts !== null && counts.total !== null) {
        const debt = counts.total - counts.in_diff;
        if (debt > 0) {
          notProven.push({
            kind: "pre-existing-debt",
            subject: g.id,
            detail: `${debt} finding(s) outside the judged lines remain unaddressed in ${where}`,
          });
        }
      }
    }
  }

  // Acceptance is reported for EVERY record, selected or not: the operator asked
  // for it, and a task that escalated without landing still leaves it unproven.
  //
  // EVERY entry is reported -- declaring a success_command suppresses NOTHING.
  // Nothing in the schema links a free-text criterion to a specific command, and
  // nothing can: `success_commands` is a flat list of shell strings. Treating one
  // `npm test` as covering every acceptance line the task declared was an
  // assertion the ledger cannot support, and it silently emptied this section for
  // exactly the tasks that declared the most. When commands ARE declared the entry
  // says so, so the reader can judge the link the harness cannot.
  for (const r of records) {
    const n = r.declared.success_commands.length;
    for (const a of r.declared.acceptance) {
      notProven.push({
        kind: "unchecked-acceptance",
        subject: a,
        detail:
          n === 0
            ? `declared by task ${r.task_id}; the task declares no success_command at all, so nothing machine-checked it`
            : `declared by task ${r.task_id}; the task declares ${n} success_command(s), but nothing links this criterion to any of them`,
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
    // SELECTED only. A range that selected nothing was judged by no ruleset, and
    // falling back to every loaded record would name a profile as if it had judged
    // this range -- a claim about commits the report explicitly did not select.
    profiles: distinctProfiles(selected),
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
