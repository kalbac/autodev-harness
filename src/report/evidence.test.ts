import { describe, it, expect, vi } from "vitest";
import { buildEvidence, writeEvidence, type EvidenceDraft } from "./evidence.js";
import { EvidenceSchema } from "./evidence-types.js";

function draft(over: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    taskId: "t1",
    runId: null,
    title: "Add a getter",
    type: "feature",
    fileSet: ["src/a.php"],
    acceptance: [],
    successCommands: [],
    profile: null,
    outcome: "escalated",
    commit: null,
    escalation: { type: "disagreement", reason: "critic did not return a clean verdict" },
    rounds: 1,
    attempts: 1,
    startedAt: "2026-07-22T10:00:00.000Z",
    endedAt: "2026-07-22T10:04:00.000Z",
    critic: { verdict: "broken", confidence: 0.76 },
    gate: null,
    profileGates: [],
    tokens: null,
    ...over,
  };
}

describe("buildEvidence", () => {
  it("produces a record that satisfies the schema", () => {
    expect(() => EvidenceSchema.parse(buildEvidence(draft()))).not.toThrow();
  });

  it("keeps the tool's TOTAL and the diff-filtered count apart — their difference is the debt", () => {
    const rec = buildEvidence(
      draft({
        profileGates: [
          {
            id: "phpcs",
            status: "green",
            exit_code: 1,
            skip_reason: null,
            scope: "changed-lines",
            files: ["src/a.php"],
            output: "",
            // The tool reported 12; only these 2 land on lines the diff added.
            findings_total: 12,
            findings: [
              { file: "src/a.php", line: 3, severity: "error", message: "m", source: "s", unattributed: false },
              { file: "src/a.php", line: 9, severity: "error", message: "m", source: "s", unattributed: true },
            ],
          },
        ],
      }),
    );
    expect(rec.profile_gates[0]!.findings).toEqual({ total: 12, in_diff: 2, unattributed: 1 });
  });

  it("records the total as NOT MEASURED (null) when the tool's count was never taken", () => {
    // `findings_total: null` means "not measured" -- neither zero nor a floor.
    // Substituting the filtered length would make `total - in_diff` zero by
    // construction, and "nothing looked" would read as "no debt": the fail-open
    // this ledger exists to prevent. The report says UNKNOWN instead.
    const rec = buildEvidence(
      draft({
        profileGates: [
          {
            id: "phpcs",
            status: "red",
            exit_code: 1,
            skip_reason: null,
            scope: "changed-lines",
            files: ["src/a.php"],
            output: "",
            findings_total: null,
            findings: [
              { file: "src/a.php", line: 3, severity: "error", message: "m", source: "s", unattributed: false },
              { file: "src/a.php", line: 9, severity: "error", message: "m", source: "s", unattributed: false },
            ],
          },
        ],
      }),
    );
    expect(rec.profile_gates[0]!.findings).toEqual({ total: null, in_diff: 2, unattributed: 0 });
    // And the record still satisfies the fail-closed schema with a null total.
    expect(() => EvidenceSchema.parse(rec)).not.toThrow();
  });

  it("keeps a skipped gate's reason", () => {
    const rec = buildEvidence(
      draft({
        profileGates: [
          { id: "phpcs", status: "skipped", exit_code: null, skip_reason: "no changed file matched **/*.php",
            scope: "changed-lines", files: [], findings: null, findings_total: null, output: "" },
        ],
      }),
    );
    expect(rec.profile_gates[0]).toMatchObject({ status: "skipped", skip_reason: "no changed file matched **/*.php", findings: null });
  });
});

describe("writeEvidence", () => {
  it("NEVER throws when the write fails (H6)", async () => {
    const log = vi.fn();
    await expect(
      writeEvidence(draft(), {
        write: async () => {
          throw new Error("disk full");
        },
        log,
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("WARN", expect.stringContaining("evidence"));
  });

  it("writes the record as pretty JSON under evidence.json", async () => {
    const write = vi.fn(async () => {});
    await writeEvidence(draft(), { write, log: vi.fn() });
    expect(write).toHaveBeenCalledWith("t1", "evidence.json", expect.stringContaining('"task_id": "t1"'));
  });
});
