import { describe, it, expect } from "vitest";
import { buildQualificationReport } from "./qualification-report.js";
import type { EvidenceSlot } from "./evidence-store.js";

function rec(over: Record<string, unknown>): EvidenceSlot {
  return {
    taskId: String(over.task_id ?? "t1"), state: "ok",
    record: {
      schema: 1, task_id: "t1", run_id: null, title: "t", type: "feature",
      declared: { file_set: [], acceptance: [], success_commands: [] },
      profile: { id: "wordpress-woocommerce", version: 2 },
      outcome: "committed", commit: "abc", escalation: null,
      rounds: 0, attempts: 1, started_at: "s", ended_at: "e",
      critic: null, gate: null, profile_gates: [], tokens: null,
      ...over,
    } as never,
  };
}

describe("buildQualificationReport", () => {
  it("sorts a line-scoped green gate into 'proven on change', never whole-product", () => {
    const r = buildQualificationReport(
      { from: "aaa", to: "bbb", commits: ["abc"] },
      [rec({ profile_gates: [{ id: "phpcs", status: "green", exit_code: 0, skip_reason: null, scope: "changed-lines", files: ["a.php"], findings: { total: 0, in_diff: 0, unattributed: 0 } }] })],
    );
    expect(r.proven_on_change.map((e) => e.gate_id)).toEqual(["phpcs"]);
    expect(r.proven_whole_product).toEqual([]);
  });

  it("names EVERY profile a range was judged under, not just the first", () => {
    // A commit range can span a profile version bump. Naming one version would
    // credit work to a ruleset that never judged it.
    const r = buildQualificationReport({ from: "aaa", to: "bbb", commits: ["c1", "c2"] }, [
      rec({ task_id: "t1", commit: "c1", profile: { id: "wordpress-woocommerce", version: 1 } }),
      rec({ task_id: "t2", commit: "c2", profile: { id: "wordpress-woocommerce", version: 2 } }),
    ]);
    expect(r.profiles).toEqual([
      { id: "wordpress-woocommerce", version: 1 },
      { id: "wordpress-woocommerce", version: 2 },
    ]);
  });

  it("deduplicates a profile shared by several records", () => {
    const r = buildQualificationReport({ from: "aaa", to: "bbb", commits: ["c1", "c2"] }, [
      rec({ task_id: "t1", commit: "c1" }),
      rec({ task_id: "t2", commit: "c2" }),
    ]);
    expect(r.profiles).toEqual([{ id: "wordpress-woocommerce", version: 2 }]);
  });

  it("puts a SKIPPED gate in 'not proven' with its reason (H2)", () => {
    const r = buildQualificationReport(
      { from: "aaa", to: "bbb", commits: ["abc"] },
      [rec({ profile_gates: [{ id: "phpcs", status: "skipped", exit_code: null, skip_reason: "no changed file matched **/*.php", scope: "changed-lines", files: [], findings: null }] })],
    );
    expect(r.not_proven).toContainEqual(expect.objectContaining({ kind: "skipped-gate", subject: "phpcs", detail: "no changed file matched **/*.php" }));
  });

  it("puts an unchecked acceptance criterion in 'not proven' (H4)", () => {
    const r = buildQualificationReport(
      { from: "aaa", to: "bbb", commits: ["abc"] },
      [rec({ declared: { file_set: [], acceptance: ["cart total is right"], success_commands: [] } })],
    );
    expect(r.not_proven).toContainEqual(expect.objectContaining({ kind: "unchecked-acceptance", subject: "cart total is right" }));
  });

  it("does NOT flag acceptance when the task declares a success_command", () => {
    const r = buildQualificationReport(
      { from: "aaa", to: "bbb", commits: ["abc"] },
      [rec({ declared: { file_set: [], acceptance: ["cart total is right"], success_commands: ["npm test"] } })],
    );
    expect(r.not_proven.filter((e) => e.kind === "unchecked-acceptance")).toEqual([]);
  });

  it("reports pre-existing debt as the difference between total and in_diff", () => {
    const r = buildQualificationReport(
      { from: "aaa", to: "bbb", commits: ["abc"] },
      [rec({ profile_gates: [{ id: "phpcs", status: "green", exit_code: 1, skip_reason: null, scope: "changed-lines", files: ["a.php"], findings: { total: 12, in_diff: 0, unattributed: 0 } }] })],
    );
    expect(r.not_proven).toContainEqual(expect.objectContaining({ kind: "pre-existing-debt", subject: "phpcs", detail: expect.stringContaining("12") }));
  });

  it("counts a record OUTSIDE the commit range as not selected", () => {
    const r = buildQualificationReport({ from: "aaa", to: "bbb", commits: ["zzz"] }, [rec({ commit: "abc" })]);
    expect(r.proven_on_change).toEqual([]);
    expect(r.completeness.selected).toBe(0);
  });

  it("still reports unproven acceptance from a task that never landed", () => {
    const r = buildQualificationReport(
      { from: "aaa", to: "bbb", commits: [] },
      [rec({ outcome: "escalated", commit: null, declared: { file_set: [], acceptance: ["must not break checkout"], success_commands: [] } })],
    );
    expect(r.not_proven).toContainEqual(expect.objectContaining({ kind: "unchecked-acceptance", subject: "must not break checkout" }));
  });
});
