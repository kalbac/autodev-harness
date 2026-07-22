# Two Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate a successful Run from a successful Product — a per-run Harness Execution Report and an on-demand, commit-scoped Product Qualification Report, both assembled from a new per-task evidence ledger.

**Architecture:** The conductor accumulates an evidence draft during a task iteration and writes it once, in a `finally`, to `runtime/<taskId>/evidence.json` (fail-soft). Profile gates stop collapsing into one boolean: `runProfileGates` returns `ProfileGateRecord[]` — including **skipped** gates — which rides to the conductor inside `GateVerdict.profile_gates`. Two pure assemblers read the ledger and emit report documents; one renderer turns either document into Markdown. The reports are pure functions of the ledger, so a renderer bug is never a ledger bug.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), zod for fail-closed reads, vitest for tests. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-22-two-reports-design.md` — honesty invariants H1–H6 are the acceptance criteria.

---

## File structure

| File | Responsibility |
|---|---|
| `src/gate/profile-gate-record.ts` (create) | `ProfileGateRecord` — the one normal form for a per-gate result |
| `src/gate/gate.ts` (modify) | `runProfileGates` returns records; `GateVerdict.profile_gates` carries them |
| `src/composition/root.ts` (modify) | The real gate runner emits records, including skipped gates |
| `src/report/evidence-types.ts` (create) | The evidence record type + zod schema (fail-closed read) |
| `src/report/evidence.ts` (create) | Build a record from a draft; fail-soft write |
| `src/conductor/conductor.ts` (modify) | Accumulate the draft; one write in `finally` |
| `src/report/evidence-store.ts` (create) | Read + select records; "absent" vs "unreadable" stay distinct |
| `src/report/execution-report.ts` (create) | Assemble the Harness Execution Report document |
| `src/report/qualification-report.ts` (create) | Assemble the Product Qualification Report document |
| `src/report/render.ts` (create) | Markdown rendering of either document |
| `src/api/server.ts` (modify) | `GET /runs/:runId/report`, `POST /qualification-report` |
| `src/index.ts` (modify) | CLI verbs `report run` / `report qualify` |

Every new module lives under `src/report/` except `ProfileGateRecord`, which belongs to the gate because the gate produces it.

---

### Task 1: `ProfileGateRecord` — one normal form for a per-gate result

Today `runProfileGates` returns `{id, green, exitCode, output?, findings?}` and a **skipped** gate returns nothing at all (`root.ts:539-544` logs an INFO line and `continue`s). A skipped gate bounds what the verdict covers, so it must become data.

The record replaces the old element shape rather than being bolted beside it. Two shapes for one value is the defect family `docs/gotchas/validated-one-string-used-another.md` names as this repo's most recurring: state the normal form once, at the entry point.

**Files:**
- Create: `src/gate/profile-gate-record.ts`
- Modify: `src/gate/gate.ts:111-118` (dep type), `:257-296` (step 1d), `:39-50` (verdict)
- Modify: `src/composition/root.ts:526-624`
- Test: `src/gate/gate.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/gate/gate.test.ts`:

```ts
import type { ProfileGateRecord } from "./profile-gate-record.js";

/** A green whole-project gate record, the shape the composition root emits. */
function gateRec(over: Partial<ProfileGateRecord> = {}): ProfileGateRecord {
  return {
    id: "phpcs",
    status: "green",
    exit_code: 0,
    skip_reason: null,
    scope: "whole-project",
    files: [],
    findings: null,
    findings_total: null,
    output: "",
    ...over,
  };
}

it("a SKIPPED profile gate does not turn the verdict red but is recorded", async () => {
  const { deps } = makeDeps({
    changedFiles: ["docs/x.md"],
    runProfileGates: async () => [
      gateRec({ id: "phpcs", status: "skipped", exit_code: null, skip_reason: "no changed file matched **/*.php", scope: "changed-lines" }),
      gateRec({ id: "composer-validate", status: "green" }),
    ],
  });
  const v = await runGate({ taskId: "t1", fileSet: ["docs/x.md"] }, deps);
  expect(v.profile_green).toBe(true);
  expect(v.decision).not.toBe("RETRY");
  expect(v.profile_gates.map((r) => [r.id, r.status])).toEqual([
    ["phpcs", "skipped"],
    ["composer-validate", "green"],
  ]);
  expect(v.profile_gates[0].skip_reason).toBe("no changed file matched **/*.php");
});

it("a RED profile gate record turns the verdict red and is recorded", async () => {
  const { deps } = makeDeps({
    changedFiles: ["src/a.php"],
    runProfileGates: async () => [gateRec({ status: "red", exit_code: 1, scope: "changed-files", files: ["src/a.php"] })],
  });
  const v = await runGate({ taskId: "t1", fileSet: ["src/a.php"] }, deps);
  expect(v.profile_green).toBe(false);
  expect(v.decision).toBe("RETRY");
  expect(v.profile_gates[0].status).toBe("red");
});

it("no profile attached leaves profile_gates empty, not absent", async () => {
  const { deps } = makeDeps({ changedFiles: ["src/foo.ts"], runProfileGates: null });
  const v = await runGate({ taskId: "t1", fileSet: ["src/foo.ts"] }, deps);
  expect(v.profile_gates).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gate/gate.test.ts`
Expected: FAIL — `Cannot find module './profile-gate-record.js'`.

- [ ] **Step 3: Create the record type**

Create `src/gate/profile-gate-record.ts`:

```ts
import type { FilteredFinding } from "./finding-filter.js";

/**
 * One profile gate's outcome for ONE task — the single normal form.
 *
 * `status: "skipped"` exists because a skipped gate is a BOUND on what the
 * verdict covers, and an unreported bound reads as coverage. Before this type
 * a skip was only an INFO log line, which meant the Product Qualification
 * Report could not tell "this check passed" from "this check never ran".
 *
 * `scope` is derived from the gate's own declaration, not from what happened:
 *   - `changed-lines`  — the gate declares `report:` (findings filtered to added lines)
 *   - `changed-files`  — the gate declares `files:` but no `report:`
 *   - `whole-project`  — the gate declares neither (e.g. `composer validate`)
 * It is what keeps a line-scoped proof from ever being read as a product-wide one.
 */
export interface ProfileGateRecord {
  id: string;
  status: "green" | "red" | "skipped";
  /** null when skipped — the gate never ran, so there is no exit code to report. */
  exit_code: number | null;
  /** Non-null only when `status === "skipped"`. */
  skip_reason: string | null;
  scope: "changed-lines" | "changed-files" | "whole-project";
  /** The changed files this gate actually ran against; empty for whole-project and skipped. */
  files: string[];
  /** Diff-filtered findings for a `report` gate; null for any other gate. */
  findings: FilteredFinding[] | null;
  /**
   * How many findings the tool reported BEFORE diff-filtering; null for a gate
   * with no report format. Kept alongside `findings` because their difference is
   * the file's pre-existing debt — the number the Product Qualification Report's
   * "not proven" section is built from. Without it the two numbers are always
   * equal by construction and the debt is invisible, which would make a
   * line-scoped green read as a whole-file proof.
   */
  findings_total: number | null;
  /** Raw tool output — feedback fallback and operator debugging. */
  output: string;
}
```

- [ ] **Step 4: Thread the record through `gate.ts`**

In `src/gate/gate.ts`, add the import and change the dep signature and step 1d:

```ts
import type { ProfileGateRecord } from "./profile-gate-record.js";
```

Replace the `runProfileGates` dep type (`:111-118`) with:

```ts
  runProfileGates: ((changedFiles: string[], addedLines: AddedLines) => Promise<ProfileGateRecord[]>) | null;
```

Add to `GateVerdict` (after `profile_green`):

```ts
  /** Per-gate records for this run, including SKIPPED gates. Empty when no profile
   *  is attached. Carried on the verdict (rather than a second return channel) so it
   *  lands in gate-verdict.json for free and reaches the conductor with no new plumbing. */
  profile_gates: ProfileGateRecord[];
```

In step 1d, replace the loop body so folding reads `status`, and hoist the records:

```ts
    let profileGreen = true;
    let profileGates: ProfileGateRecord[] = [];
    if (deps.runProfileGates !== null) {
      const addedLines = addedLineNumbers(diffText);
      profileGates = await deps.runProfileGates(changedFiles, addedLines);
      for (const r of profileGates) {
        // Only "red" is worker-fixable failure. "skipped" must never turn the
        // verdict red: the gate did not judge this diff, which is a coverage
        // bound (reported by the Qualification Report), not a defect.
        if (r.status !== "red") {
          continue;
        }
        profileGreen = false;
        reasons.push(`profile gate '${r.id}' FAILED (exit ${r.exit_code ?? "n/a"})`);
        failedSteps.push({
          label: `profile gate '${r.id}'`,
          exitCode: r.exit_code,
          output: r.output,
          ...(r.findings !== null ? { findings: r.findings } : {}),
        });
      }
    }
```

Add `profile_gates: profileGates,` to the constructed verdict (`:417-428`), and `profile_gates: [],` to the empty-file_set fast-path verdict (`:159-170`).

- [ ] **Step 5: Emit records from the composition root**

In `src/composition/root.ts`, replace the `runProfileGates` closure body (`:529-624`). The `out` array type becomes `ProfileGateRecord[]`, the skip branch now pushes instead of only logging, and `scope` is derived from the gate declaration:

```ts
          : async (changedFiles: string[], addedLines: AddedLines) => {
              const out: ProfileGateRecord[] = [];
              for (const g of profile.gates) {
                // Derived from the DECLARATION, never from the outcome.
                const scope: ProfileGateRecord["scope"] =
                  g.report !== null ? "changed-lines" : g.filesGlob !== null ? "changed-files" : "whole-project";
                const inv = prepareGateInvocation(g, changedFiles);
                if (inv.skipped) {
                  // Still logged (unchanged), AND now recorded: a skipped gate is a
                  // bound on what this verdict covers, and an unreported bound reads
                  // as coverage.
                  log("INFO", `profile gate '${g.id}' skipped -- ${inv.reason}`);
                  out.push({
                    id: g.id,
                    status: "skipped",
                    exit_code: null,
                    skip_reason: inv.reason,
                    scope,
                    files: [],
                    findings: null,
                    findings_total: null,
                    output: "",
                  });
                  continue;
                }
                const { c, a } = splitCommand(inv.command);
                const r = await runNative(c, a, { cwd: wt.path });

                // SAFETY-CRITICAL ORDERING (unchanged from Task 4 of the line-scoping
                // plan): classify FIRST, parse only on RED. An unrunnable exit fed to
                // the parser reads as zero findings, which downstream means CLEAN — a
                // broken gate would become a PASS.
                const verdict = classifyGateExit(g, r.exitCode);
                if (verdict === "unrunnable") {
                  throw new Error(
                    `profile gate '${g.id}' exited ${r.exitCode}, which is neither 0 nor one of its declared red ` +
                      `exit codes [${g.redExitCodes.join(", ")}] -- the gate could not complete (not a ` +
                      `worker-fixable failure)`,
                  );
                }

                const scopedFiles = g.filesGlob === null ? [] : changedFiles.filter((f) => globMatch(g.filesGlob!, f));

                if (verdict === "green") {
                  // Exit 0: the tool reported nothing, so there is nothing to parse
                  // and no debt to measure. `findings_total: null` means "not
                  // measured" -- deliberately not `0`, which would claim the file is
                  // clean when this run never looked.
                  out.push({
                    id: g.id, status: "green", exit_code: r.exitCode, skip_reason: null,
                    scope, files: scopedFiles, findings: null, findings_total: null, output: mergedOutput(r),
                  });
                  continue;
                }

                if (g.report === null) {
                  out.push({
                    id: g.id, status: "red", exit_code: r.exitCode, skip_reason: null,
                    scope, files: scopedFiles, findings: null, findings_total: null, output: mergedOutput(r),
                  });
                  continue;
                }

                const parsed = parseCheckstyle(r.stdout);
                const filtered = filterFindings(parsed, addedLines.added, wt.path, addedLines.newFiles);
                out.push({
                  id: g.id,
                  // The verdict comes from the FILTERED count, not the exit code: a tool
                  // legitimately exits non-zero while every finding sits outside this diff.
                  status: filtered.length === 0 ? "green" : "red",
                  exit_code: r.exitCode,
                  skip_reason: null,
                  scope,
                  files: scopedFiles,
                  findings: filtered,
                  // The tool's FULL count, before diff-filtering. `filtered.length`
                  // is what the worker owns; the difference is the file's
                  // pre-existing debt, which the Qualification Report names.
                  findings_total: parsed.length,
                  output: mergedOutput(r),
                });
              }
              return out;
            },
```

Add the imports `import type { ProfileGateRecord } from "../gate/profile-gate-record.js";` and, if not already present, `import { globMatch } from "../util/glob.js";` (check the existing import block first — do not duplicate it).

- [ ] **Step 6: Fix the other test fakes**

Run: `npx vitest run src/gate/gate.test.ts src/conductor/conductor.test.ts test/parity/parity.test.ts`
Every `runProfileGates` fake returning the old `{id, green, exitCode}` shape now fails to typecheck. Convert each to the `gateRec()` helper from Step 1: `green: true` → `status: "green"`, `green: false` → `status: "red"`, `exitCode` → `exit_code`, `output` stays, `findings` becomes `null` when absent. `makeReportGateRun` (`gate.test.ts:35`) returns the same helper shape.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/gate/profile-gate-record.ts src/gate/gate.ts src/composition/root.ts src/gate/gate.test.ts src/conductor/conductor.test.ts test/parity/parity.test.ts
git commit -m "feat(gate): per-profile-gate records, including skipped gates"
```

---

### Task 2: The evidence record type

**Files:**
- Create: `src/report/evidence-types.ts`
- Test: `src/report/evidence-types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/report/evidence-types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EvidenceSchema, type EvidenceRecord } from "./evidence-types.js";

function minimal(): unknown {
  return {
    schema: 1,
    task_id: "t1",
    run_id: null,
    title: "Add a getter",
    type: "feature",
    declared: { file_set: ["src/a.php"], acceptance: [], success_commands: [] },
    profile: null,
    outcome: "committed",
    commit: "abc1234",
    escalation: null,
    rounds: 0,
    attempts: 1,
    started_at: "2026-07-22T10:00:00.000Z",
    ended_at: "2026-07-22T10:04:00.000Z",
    critic: null,
    gate: null,
    profile_gates: [],
    tokens: null,
  };
}

describe("EvidenceSchema", () => {
  it("parses a minimal record", () => {
    const r: EvidenceRecord = EvidenceSchema.parse(minimal());
    expect(r.task_id).toBe("t1");
    expect(r.outcome).toBe("committed");
  });

  it("REJECTS an unknown key rather than stripping it", () => {
    const bad = { ...(minimal() as object), surprise: 1 };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });

  it("REJECTS an unknown outcome", () => {
    const bad = { ...(minimal() as object), outcome: "probably-fine" };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });

  it("REJECTS a future schema version", () => {
    const bad = { ...(minimal() as object), schema: 2 };
    expect(() => EvidenceSchema.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/evidence-types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

Create `src/report/evidence-types.ts`:

```ts
import { z } from "zod";

/**
 * One task's evidence — the ledger both reports are assembled from.
 *
 * `.strict()` everywhere and an exact `schema` literal: a record this harness
 * cannot fully understand must read as UNREADABLE, never as a partially-trusted
 * pass (Principle 10 — when unsure, fail toward the safe state). A stripped
 * unknown key is exactly how a config once silently reverted to defaults
 * (docs/gotchas/zod-strip-unknown-keys-silent-config-revert.md).
 *
 * Types are derived with `z.infer` rather than hand-written, because
 * `.optional()` under `exactOptionalPropertyTypes` does not mean what a
 * hand-written `x?: T` means (docs/gotchas/zod-optional-exactoptional-derive-types.md).
 * Every field here is REQUIRED and nullable instead of optional, so there is one
 * way to say "not applicable".
 */
export const EVIDENCE_SCHEMA_VERSION = 1;

const ZoneRecord = z
  .object({
    id: z.string(),
    guarded: z.boolean(),
    mutation_passed: z.boolean(),
    blessed: z.boolean(),
  })
  .strict();

const FindingCounts = z
  .object({
    total: z.number().int().nonnegative(),
    in_diff: z.number().int().nonnegative(),
    unattributed: z.number().int().nonnegative(),
  })
  .strict();

const ProfileGateEvidence = z
  .object({
    id: z.string(),
    status: z.enum(["green", "red", "skipped"]),
    exit_code: z.number().int().nullable(),
    skip_reason: z.string().nullable(),
    scope: z.enum(["changed-lines", "changed-files", "whole-project"]),
    files: z.array(z.string()),
    findings: FindingCounts.nullable(),
  })
  .strict();

const GateEvidence = z
  .object({
    decision: z.enum(["COMMIT", "RETRY", "ESCALATE"]),
    composer_green: z.boolean(),
    success_green: z.boolean(),
    agent_ci_green: z.boolean(),
    profile_green: z.boolean(),
    constitution_touched: z.array(z.string()),
    zones: z.array(ZoneRecord),
    changed_files: z.array(z.string()),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    schema: z.literal(EVIDENCE_SCHEMA_VERSION),
    task_id: z.string(),
    run_id: z.string().nullable(),
    title: z.string(),
    type: z.string(),
    declared: z
      .object({
        file_set: z.array(z.string()),
        acceptance: z.array(z.string()),
        success_commands: z.array(z.string()),
      })
      .strict(),
    profile: z.object({ id: z.string(), version: z.number().int() }).strict().nullable(),
    outcome: z.enum(["committed", "quarantined", "escalated", "abandoned"]),
    commit: z.string().nullable(),
    escalation: z.object({ type: z.string(), reason: z.string() }).strict().nullable(),
    rounds: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    started_at: z.string(),
    ended_at: z.string(),
    critic: z
      .object({ verdict: z.enum(["clean", "broken", "uncertain"]), confidence: z.number() })
      .strict()
      .nullable(),
    gate: GateEvidence.nullable(),
    profile_gates: z.array(ProfileGateEvidence),
    tokens: z
      .object({ worker_total: z.number().int().nonnegative(), critic_total: z.number().int().nonnegative() })
      .strict()
      .nullable(),
  })
  .strict();

export type EvidenceRecord = z.infer<typeof EvidenceSchema>;
export type ProfileGateEvidenceRecord = z.infer<typeof ProfileGateEvidence>;
```

Note the deliberate narrowing: evidence stores **finding counts**, not the findings themselves. The report needs `total` versus `in_diff` (their difference is the named debt); the finding bodies already live in `gate-feedback.md`, and duplicating them would make a ledger entry grow without bound.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/evidence-types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/evidence-types.ts src/report/evidence-types.test.ts
git commit -m "feat(report): evidence record schema (fail-closed)"
```

---

### Task 3: Build a record from a draft

A pure builder, so the conductor's `finally` stays trivial and the mapping is unit-testable without a conductor.

**Files:**
- Create: `src/report/evidence.ts`
- Test: `src/report/evidence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/report/evidence.test.ts`:

```ts
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
    expect(rec.profile_gates[0].findings).toEqual({ total: 12, in_diff: 2, unattributed: 1 });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/evidence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the builder and the fail-soft writer**

Create `src/report/evidence.ts`:

```ts
import type { ProfileGateRecord } from "../gate/profile-gate-record.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "./evidence-types.js";

/** What the conductor accumulates during one task iteration. */
export interface EvidenceDraft {
  taskId: string;
  runId: string | null;
  title: string;
  type: string;
  fileSet: string[];
  acceptance: string[];
  successCommands: string[];
  profile: { id: string; version: number } | null;
  outcome: EvidenceRecord["outcome"];
  commit: string | null;
  escalation: { type: string; reason: string } | null;
  rounds: number;
  attempts: number;
  startedAt: string;
  endedAt: string;
  critic: { verdict: "clean" | "broken" | "uncertain"; confidence: number } | null;
  gate: EvidenceRecord["gate"];
  profileGates: ProfileGateRecord[];
  tokens: { worker_total: number; critic_total: number } | null;
}

export interface EvidenceDeps {
  write: (taskId: string, name: string, content: string) => Promise<void>;
  log: (level: string, msg: string) => void;
}

export const EVIDENCE_FILE = "evidence.json";

/** Pure: draft -> record. Findings collapse to counts (see evidence-types.ts). */
export function buildEvidence(d: EvidenceDraft): EvidenceRecord {
  return {
    schema: EVIDENCE_SCHEMA_VERSION,
    task_id: d.taskId,
    run_id: d.runId,
    title: d.title,
    type: d.type,
    declared: { file_set: d.fileSet, acceptance: d.acceptance, success_commands: d.successCommands },
    profile: d.profile,
    outcome: d.outcome,
    commit: d.commit,
    escalation: d.escalation,
    rounds: d.rounds,
    attempts: d.attempts,
    started_at: d.startedAt,
    ended_at: d.endedAt,
    critic: d.critic,
    gate: d.gate,
    profile_gates: d.profileGates.map((g) => ({
      id: g.id,
      status: g.status,
      exit_code: g.exit_code,
      skip_reason: g.skip_reason,
      scope: g.scope,
      files: g.files,
      findings:
        g.findings === null
          ? null
          : {
              // `total` is the tool's FULL count and `in_diff` the surviving,
              // diff-filtered one. They are different numbers and their difference
              // is the file's pre-existing debt -- the whole reason the ledger keeps
              // both. Falling back to the filtered length when `findings_total` was
              // never measured is the honest floor: it can understate the debt, never
              // invent one.
              total: g.findings_total ?? g.findings.length,
              in_diff: g.findings.length,
              unattributed: g.findings.filter((f) => f.unattributed).length,
            },
    })),
    tokens: d.tokens,
  };
}

/**
 * Fail-soft by contract (H6): evidence is bookkeeping ABOUT the enforcement loop
 * and must never be able to fail it. A report assembled over a missing record
 * says so honestly (H1), which is the safe direction; a task escalated because
 * its evidence write failed would not be.
 */
export async function writeEvidence(d: EvidenceDraft, deps: EvidenceDeps): Promise<void> {
  try {
    await deps.write(d.taskId, EVIDENCE_FILE, JSON.stringify(buildEvidence(d), null, 2));
  } catch (err) {
    try {
      deps.log("WARN", `conductor: persisting evidence for ${d.taskId} failed (ignored): ${String(err)}`);
    } catch {
      // A throwing logger inside the catch must not resurrect the failure
      // (docs/gotchas/never-throws-catch-block-logging.md).
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/evidence.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/evidence.ts src/report/evidence.test.ts
git commit -m "feat(report): evidence builder + fail-soft writer"
```

---

### Task 4: The conductor writes evidence once per iteration

One call site, in a `finally` — the same write-once idiom `gate-feedback.md` uses, and for the same reason: ten decisive exits are ten chances to forget one.

**Files:**
- Modify: `src/conductor/conductor.ts` (inside `runIteration`)
- Test: `src/conductor/conductor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/conductor/conductor.test.ts` (reuse the file's existing harness for building a conductor with fakes — follow the closest existing test's setup):

```ts
it("writes evidence.json for a COMMITTED task, with the commit hash", async () => {
  // ... existing harness that drives one task to COMMIT ...
  const written = writes.find((w) => w.name === "evidence.json");
  expect(written).toBeDefined();
  const rec = JSON.parse(written!.content);
  expect(rec.outcome).toBe("committed");
  expect(rec.commit).toBe(COMMIT_HASH);
  expect(rec.rounds).toBe(0);
  expect(rec.gate.decision).toBe("COMMIT");
});

it("writes evidence.json for an ESCALATED task, naming the escalation type", async () => {
  // ... existing harness that drives one task to a critic escalation ...
  const rec = JSON.parse(writes.find((w) => w.name === "evidence.json")!.content);
  expect(rec.outcome).toBe("escalated");
  expect(rec.commit).toBeNull();
  expect(rec.escalation.type).toBe("disagreement");
});

it("an evidence write failure does NOT fail the iteration (H6)", async () => {
  // ... harness whose writeRuntimeFile throws for name === "evidence.json" ...
  const res = await conductor.run({ once: true });
  expect(res).toBeDefined(); // no throw, task still committed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/conductor/conductor.test.ts`
Expected: FAIL — no `evidence.json` write.

- [ ] **Step 3: Accumulate the draft**

In `src/conductor/conductor.ts`, inside `runIteration`, right after `const attempts = ...` (`:283-284`) declare the draft. It is mutable on purpose: every decisive exit records its outcome by assignment, and exactly one place writes.

```ts
    // EVIDENCE (spec 2026-07-22 "two reports"). Accumulated here and written ONCE
    // in the `finally` below. A mutable draft plus a single write is deliberate:
    // this function has ten decisive exits, and a write at each is ten chances to
    // forget one -- the same reasoning that made gate-feedback.md write-or-clear
    // from a single `finally` (docs/gotchas/per-round-overwrite-artifact-stale.md).
    // The default outcome is "abandoned": if an exit forgets to set one, the record
    // says the task ended without a recorded decision, which is honest, rather than
    // claiming a success that never happened (Principle 10).
    const evidence: EvidenceDraft = {
      taskId: task.id,
      runId: task.run_id ?? null,
      title: task.title,
      type: task.type,
      fileSet: task.file_set,
      acceptance: task.acceptance,
      successCommands: task.success_commands,
      profile: profileRef,
      outcome: "abandoned",
      commit: null,
      escalation: null,
      rounds: 0,
      attempts,
      startedAt: new Date(clock.now()).toISOString(),
      endedAt: new Date(clock.now()).toISOString(),
      critic: null,
      gate: null,
      profileGates: [],
      tokens: null,
    };
```

`profileRef` is a new optional conductor dep — `{ id: string; version: number } | null`, defaulted `null` — supplied by the composition root from the already-loaded `ResolvedProfile`. Add it to the conductor's deps interface beside the existing ones and pass `profile === null ? null : { id: profile.id, version: profile.version }` at the root.

If `Task` has no `run_id` field, use `null` and leave run attribution to the run manifest (`taskIds`), which Task 5 reads anyway; do **not** invent a field on `Task`.

- [ ] **Step 4: Record at each exit**

At the circuit-breaker quarantine (`:286-299`), before the `return`:

```ts
      evidence.outcome = "quarantined";
      evidence.escalation = { type: "poison", reason: "circuit breaker tripped -- too many attempts" };
```

At the critic-escalation branch (`:597-631`), before its `return`:

```ts
      evidence.outcome = "escalated";
      evidence.rounds = round;
      evidence.escalation = { type: escType, reason: "critic did not return a clean verdict" };
      if (cr.verdict) {
        evidence.critic = { verdict: cr.verdict.verdict, confidence: cr.verdict.confidence };
      }
```

At the clean break (`:583-588`), after `persistCriticVerdict`:

```ts
        evidence.rounds = round;
        evidence.critic = { verdict: cr.verdict.verdict, confidence: cr.verdict.confidence };
```

After a successful `runGate` (`:669`, immediately after the try/catch):

```ts
      evidence.gate = {
        decision: gv.decision,
        composer_green: gv.composer_green,
        success_green: gv.success_green,
        agent_ci_green: gv.agent_ci_green,
        profile_green: gv.profile_green,
        constitution_touched: gv.constitution_touched,
        zones: gv.zones_touched.map((z) => ({
          id: z.id, guarded: z.guarded, mutation_passed: z.mutation_passed, blessed: z.blessed,
        })),
        changed_files: gv.changed_files,
      };
      evidence.profileGates = gv.profile_gates;
```

In the gate-threw catch (`:646-668`): `evidence.outcome = "escalated"; evidence.escalation = { type: escType, reason };`
On RETRY (`:672-675`): `evidence.outcome = "abandoned";` — the task goes back to pending, so this iteration decided nothing; the next iteration overwrites the record. (Overwrite is correct here for the same reason write-or-clear is: the artifact must describe the most recent run.)
On the successful commit (`:746`): `evidence.outcome = "committed"; evidence.commit = hash;`
On the branch-moved and merge-refused escalations, and on the final gate-did-not-COMMIT escalation, and in the backstop catch: `evidence.outcome = "escalated"` plus the matching `escalation` fields, using the same `reason` string already passed to `buildEscalation` — read it from the same variable rather than retyping the literal.

- [ ] **Step 5: Write once, in `finally`**

Extend the existing `finally` of `runIteration`'s outer `try` (the block that already tears the worktree down). Put the evidence write FIRST, so a teardown failure cannot lose it:

```ts
    } finally {
      evidence.endedAt = new Date(clock.now()).toISOString();
      evidence.tokens = {
        worker_total: workerRuns.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0),
        critic_total: criticRuns.reduce((n, r) => n + r.tokens, 0),
      };
      await writeEvidence(evidence, {
        write: (id, name, content) => repo.writeRuntimeFile(id, name, content),
        log: safeLog,
      });
      // ... existing teardown ...
    }
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run src/conductor/conductor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/conductor/conductor.ts src/conductor/conductor.test.ts src/composition/root.ts
git commit -m "feat(report): conductor writes a per-task evidence record"
```

---

### Task 5: The evidence store — selection that distinguishes absent from unreadable

**Files:**
- Create: `src/report/evidence-store.ts`
- Test: `src/report/evidence-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/report/evidence-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadEvidence, type EvidenceSlot } from "./evidence-store.js";

const good = JSON.stringify({
  schema: 1, task_id: "t1", run_id: null, title: "x", type: "feature",
  declared: { file_set: [], acceptance: [], success_commands: [] },
  profile: null, outcome: "committed", commit: "abc", escalation: null,
  rounds: 0, attempts: 1, started_at: "s", ended_at: "e",
  critic: null, gate: null, profile_gates: [], tokens: null,
});

describe("loadEvidence", () => {
  it("returns ok for a valid record", async () => {
    const slots = await loadEvidence(["t1"], async () => good);
    expect(slots[0]).toMatchObject({ taskId: "t1", state: "ok" });
  });

  it("distinguishes ABSENT from UNREADABLE (H1)", async () => {
    const absent = await loadEvidence(["t1"], async () => null);
    expect(absent[0]).toMatchObject({ taskId: "t1", state: "absent" });

    const broken = await loadEvidence(["t1"], async () => "{not json");
    expect(broken[0]).toMatchObject({ taskId: "t1", state: "unreadable" });

    const wrongShape = await loadEvidence(["t1"], async () => JSON.stringify({ schema: 1 }));
    expect(wrongShape[0]).toMatchObject({ taskId: "t1", state: "unreadable" });
  });

  it("a read that THROWS is unreadable, never absent", async () => {
    const slots = await loadEvidence(["t1"], async () => {
      throw new Error("EACCES");
    });
    expect(slots[0].state).toBe("unreadable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/evidence-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

Create `src/report/evidence-store.ts`:

```ts
import { EvidenceSchema, type EvidenceRecord } from "./evidence-types.js";
import { EVIDENCE_FILE } from "./evidence.js";

/**
 * A task's slot in the ledger. "absent" and "unreadable" stay DISTINCT because
 * they mean different things to a reader: absent is usually a task that predates
 * the ledger or never ran; unreadable is a defect. Folding either into a pass is
 * the fail-open this feature exists to avoid (H1). Note the errno lesson from
 * docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md: a read that
 * FAILS is never evidence of absence -- only a reader that positively reports
 * "no such file" (a `null` return) is.
 */
export type EvidenceSlot =
  | { taskId: string; state: "ok"; record: EvidenceRecord }
  | { taskId: string; state: "absent" }
  | { taskId: string; state: "unreadable"; detail: string };

/** `read` returns the file's text, or `null` when the file does not exist. */
export type EvidenceReader = (taskId: string) => Promise<string | null>;

export async function loadEvidence(taskIds: string[], read: EvidenceReader): Promise<EvidenceSlot[]> {
  const out: EvidenceSlot[] = [];
  for (const taskId of taskIds) {
    let text: string | null;
    try {
      text = await read(taskId);
    } catch (err) {
      out.push({ taskId, state: "unreadable", detail: String(err) });
      continue;
    }
    if (text === null) {
      out.push({ taskId, state: "absent" });
      continue;
    }
    try {
      out.push({ taskId, state: "ok", record: EvidenceSchema.parse(JSON.parse(text)) });
    } catch (err) {
      out.push({ taskId, state: "unreadable", detail: String(err) });
    }
  }
  return out;
}

/** The name a reader implementation must read. Exported so no caller retypes it. */
export { EVIDENCE_FILE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/evidence-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/evidence-store.ts src/report/evidence-store.test.ts
git commit -m "feat(report): evidence store with absent/unreadable separation"
```

---

### Task 6: The Harness Execution Report

**Files:**
- Create: `src/report/execution-report.ts`
- Test: `src/report/execution-report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/report/execution-report.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildExecutionReport } from "./execution-report.js";
import type { EvidenceSlot } from "./evidence-store.js";

function ok(taskId: string, over: Record<string, unknown> = {}): EvidenceSlot {
  return {
    taskId, state: "ok",
    record: {
      schema: 1, task_id: taskId, run_id: "run-1", title: taskId, type: "feature",
      declared: { file_set: [], acceptance: [], success_commands: [] },
      profile: null, outcome: "committed", commit: "abc", escalation: null,
      rounds: 0, attempts: 1, started_at: "2026-07-22T10:00:00.000Z", ended_at: "2026-07-22T10:05:00.000Z",
      critic: { verdict: "clean", confidence: 0.9 }, gate: null, profile_gates: [],
      tokens: { worker_total: 100, critic_total: 40 },
      ...over,
    } as never,
  };
}

describe("buildExecutionReport", () => {
  it("rolls up first-pass gate rate and tokens", () => {
    const r = buildExecutionReport({ runId: "run-1", intent: "do a thing", at: 0 }, [
      ok("t1"),
      ok("t2", { rounds: 2 }),
    ]);
    expect(r.tasks).toHaveLength(2);
    expect(r.rollups.committed).toBe(2);
    expect(r.rollups.first_pass).toBe(1); // t2 needed retries
    expect(r.rollups.tokens.worker_total).toBe(200);
  });

  it("reports evidence completeness honestly (H1)", () => {
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, [
      ok("t1"),
      { taskId: "t2", state: "absent" },
      { taskId: "t3", state: "unreadable", detail: "bad json" },
    ]);
    expect(r.completeness).toEqual({ total: 3, recorded: 1, absent: 1, unreadable: 1 });
  });

  it("counts escalations by type", () => {
    const r = buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, [
      ok("t1", { outcome: "escalated", escalation: { type: "disagreement", reason: "r" }, commit: null }),
      ok("t2", { outcome: "escalated", escalation: { type: "disagreement", reason: "r" }, commit: null }),
      ok("t3", { outcome: "escalated", escalation: { type: "constitution", reason: "r" }, commit: null }),
    ]);
    expect(r.rollups.escalations_by_type).toEqual({ disagreement: 2, constitution: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/execution-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the assembler**

Create `src/report/execution-report.ts`:

```ts
import type { EvidenceSlot } from "./evidence-store.js";

export interface RunRef {
  runId: string;
  intent: string;
  at: number;
}

export interface ExecutionTaskLine {
  task_id: string;
  title: string;
  outcome: string;
  commit: string | null;
  rounds: number;
  attempts: number;
  critic: { verdict: string; confidence: number } | null;
  gate_decision: string | null;
  /** Which gate greens were false — named, so a reader never has to guess. */
  gate_failures: string[];
  escalation_type: string | null;
  tokens: { worker_total: number; critic_total: number } | null;
}

export interface ExecutionReport {
  kind: "harness-execution";
  run: RunRef;
  completeness: { total: number; recorded: number; absent: number; unreadable: number };
  tasks: ExecutionTaskLine[];
  rollups: {
    committed: number;
    escalated: number;
    quarantined: number;
    /** Tasks that committed with rounds === 0 — the critic accepted the first diff. */
    first_pass: number;
    escalations_by_type: Record<string, number>;
    tokens: { worker_total: number; critic_total: number };
  };
}

/**
 * DIAGNOSTICS ONLY. This report answers "how did the machine perform", never
 * "is the product good" — which is why it does not read `profile_gates[].findings`
 * at all (H5). The separation is structural, not a matter of discipline: the
 * finding counts are simply never consulted here.
 */
export function buildExecutionReport(run: RunRef, slots: EvidenceSlot[]): ExecutionReport {
  const records = slots.flatMap((s) => (s.state === "ok" ? [s.record] : []));

  const tasks: ExecutionTaskLine[] = records.map((r) => {
    const gateFailures: string[] = [];
    if (r.gate) {
      if (!r.gate.composer_green) gateFailures.push("check command");
      if (!r.gate.success_green) gateFailures.push("success_command");
      if (!r.gate.agent_ci_green) gateFailures.push("agent-ci");
      if (!r.gate.profile_green) gateFailures.push("profile gates");
    }
    return {
      task_id: r.task_id,
      title: r.title,
      outcome: r.outcome,
      commit: r.commit,
      rounds: r.rounds,
      attempts: r.attempts,
      critic: r.critic,
      gate_decision: r.gate?.decision ?? null,
      gate_failures: gateFailures,
      escalation_type: r.escalation?.type ?? null,
      tokens: r.tokens,
    };
  });

  const escalationsByType: Record<string, number> = {};
  for (const r of records) {
    if (r.escalation) {
      escalationsByType[r.escalation.type] = (escalationsByType[r.escalation.type] ?? 0) + 1;
    }
  }

  return {
    kind: "harness-execution",
    run,
    completeness: {
      total: slots.length,
      recorded: records.length,
      absent: slots.filter((s) => s.state === "absent").length,
      unreadable: slots.filter((s) => s.state === "unreadable").length,
    },
    tasks,
    rollups: {
      committed: records.filter((r) => r.outcome === "committed").length,
      escalated: records.filter((r) => r.outcome === "escalated").length,
      quarantined: records.filter((r) => r.outcome === "quarantined").length,
      first_pass: records.filter((r) => r.outcome === "committed" && r.rounds === 0).length,
      escalations_by_type: escalationsByType,
      tokens: {
        worker_total: records.reduce((n, r) => n + (r.tokens?.worker_total ?? 0), 0),
        critic_total: records.reduce((n, r) => n + (r.tokens?.critic_total ?? 0), 0),
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/execution-report.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/execution-report.ts src/report/execution-report.test.ts
git commit -m "feat(report): harness execution report assembler"
```

---

### Task 7: The Product Qualification Report

**Files:**
- Create: `src/report/qualification-report.ts`
- Test: `src/report/qualification-report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/report/qualification-report.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/qualification-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the assembler**

Create `src/report/qualification-report.ts`:

```ts
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
  profile: { id: string; version: number } | null;
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
    profile: selected.find((r) => r.profile !== null)?.profile ?? records.find((r) => r.profile !== null)?.profile ?? null,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/qualification-report.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/qualification-report.ts src/report/qualification-report.test.ts
git commit -m "feat(report): product qualification report assembler"
```

---

### Task 8: Rendering — and the structural proof that the two never mix

**Files:**
- Create: `src/report/render.ts`
- Test: `src/report/render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/report/render.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderExecutionReport, renderQualificationReport } from "./render.js";
import { buildExecutionReport } from "./execution-report.js";
import { buildQualificationReport } from "./qualification-report.js";

describe("renderQualificationReport", () => {
  it("NEVER emits a bare 'qualified' verdict — the summary carries profile, range and counts (H3)", () => {
    const doc = buildQualificationReport({ from: "aaa", to: "bbb", commits: [] }, []);
    const md = renderQualificationReport(doc);
    expect(md).toContain("aaa..bbb");
    expect(md).toContain("proven on change");
    expect(md).toContain("not proven");
    expect(md).not.toMatch(/^\s*qualified\s*$/im);
  });

  it("does not leak execution vocabulary (H5)", () => {
    const md = renderQualificationReport(buildQualificationReport({ from: "a", to: "b", commits: [] }, []));
    for (const word of ["token", "round", "attempt", "confidence"]) {
      expect(md.toLowerCase()).not.toContain(word);
    }
  });
});

describe("renderExecutionReport", () => {
  it("does not leak product vocabulary (H5)", () => {
    const md = renderExecutionReport(buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, []));
    for (const word of ["finding", "qualif", "debt", "proven"]) {
      expect(md.toLowerCase()).not.toContain(word);
    }
  });

  it("states evidence completeness", () => {
    const md = renderExecutionReport(
      buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, [{ taskId: "t1", state: "absent" }]),
    );
    expect(md).toMatch(/evidence.*0 of 1/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the renderers**

Create `src/report/render.ts`:

```ts
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
```

Note: the H5 vocabulary tests constrain the prose. If a word like "round" is needed in the qualification renderer, the test is right and the prose is wrong — reword it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/render.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/report/render.ts src/report/render.test.ts
git commit -m "feat(report): markdown renderers with a structural no-mixing test"
```

---

### Task 9: Wiring — auto-write on run terminal, endpoints, CLI

**Files:**
- Create: `src/report/report-service.ts`
- Modify: `src/composition/root.ts`, `src/api/server.ts`, `src/index.ts`
- Test: `src/report/report-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/report/report-service.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { refreshExecutionReports } from "./report-service.js";

describe("refreshExecutionReports", () => {
  it("writes a report for a run whose tasks are all terminal-or-escalated", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "done",
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).toHaveBeenCalledWith("run-1", expect.stringContaining("Harness Execution Report"), expect.any(String));
  });

  it("does NOT write while a task is still pending", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "pending",
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("treats an ESCALATED task as terminal (a parked run still gets its report)", async () => {
    const write = vi.fn(async () => {});
    await refreshExecutionReports({
      listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
      taskState: async () => "escalated",
      readEvidence: async () => null,
      reportExists: async () => false,
      writeReport: write,
      log: vi.fn(),
    });
    expect(write).toHaveBeenCalled();
  });

  it("never throws when a write fails", async () => {
    await expect(
      refreshExecutionReports({
        listRuns: async () => [{ runId: "run-1", intent: "x", at: 0, taskIds: ["t1"] }],
        taskState: async () => "done",
        readEvidence: async () => null,
        reportExists: async () => false,
        writeReport: async () => {
          throw new Error("nope");
        },
        log: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/report/report-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

Create `src/report/report-service.ts`:

```ts
import { loadEvidence } from "./evidence-store.js";
import { buildExecutionReport } from "./execution-report.js";
import { renderExecutionReport } from "./render.js";

export interface RunListEntry {
  runId: string;
  intent: string;
  at: number;
  taskIds: string[];
}

export interface ReportServiceDeps {
  listRuns: () => Promise<RunListEntry[]>;
  /** The queue a task currently sits in, or null when it cannot be located. */
  taskState: (taskId: string) => Promise<string | null>;
  readEvidence: (taskId: string) => Promise<string | null>;
  reportExists: (runId: string) => Promise<boolean>;
  writeReport: (runId: string, markdown: string, json: string) => Promise<void>;
  log: (level: string, msg: string) => void;
}

/**
 * A run is finished when no task is still `pending` or `active`. An ESCALATED task
 * counts as finished on purpose: it is parked awaiting an operator, and a run that
 * waits forever for one would never produce a report at all — the same predicate
 * the narrator needed for exactly this reason
 * (docs/gotchas/escalated-run-not-terminal.md).
 *
 * A task whose state cannot be determined is treated as NOT finished: a report
 * written over a run that is still moving would be wrong, and waiting is the
 * cheap failure (Principle 10).
 */
const UNFINISHED = new Set(["pending", "active"]);

export async function refreshExecutionReports(deps: ReportServiceDeps): Promise<void> {
  try {
    const runs = await deps.listRuns();
    for (const run of runs) {
      if (await deps.reportExists(run.runId)) continue;

      let finished = true;
      for (const id of run.taskIds) {
        const state = await deps.taskState(id);
        if (state === null || UNFINISHED.has(state)) {
          finished = false;
          break;
        }
      }
      if (!finished) continue;

      const slots = await loadEvidence(run.taskIds, deps.readEvidence);
      const doc = buildExecutionReport({ runId: run.runId, intent: run.intent, at: run.at }, slots);
      await deps.writeReport(run.runId, renderExecutionReport(doc), JSON.stringify(doc, null, 2));
      deps.log("INFO", `report: wrote execution report for ${run.runId}`);
    }
  } catch (err) {
    // Reporting is bookkeeping about the loop; it must never break the loop.
    try {
      deps.log("WARN", `report: refreshing execution reports failed (ignored): ${String(err)}`);
    } catch {
      /* a throwing logger must not resurrect the failure */
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/report/report-service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it at the composition root**

In `src/composition/root.ts`, build the deps against the existing repository and run-manifest readers, writing to `<stateDir>/reports/run-<runId>.md` and `.json`. Call `refreshExecutionReports(...)` once **after** `conductor.run(...)` resolves (both the CLI `run` path in `src/index.ts` and the daemon's trigger path), never inside the iteration loop.

- [ ] **Step 6: Add the endpoints**

In `src/api/server.ts`, following the existing per-project route style:

- `GET /projects/:projectId/runs/:runId/report` — returns the stored execution report JSON; `404` when it has not been written yet (the run is still moving), with `{error:"report not ready"}`.
- `POST /projects/:projectId/qualification-report` — body `{from?: string, to?: string}`. Resolves the commit list with `git rev-list <from>..<to>` (default `to` = `HEAD`, default `from` = the root commit), loads every task's evidence, and returns `{json, markdown}`. POST because producing a product claim is an act, not a read.

Validate `runId` with the SAME validator the existing run routes use (`safeRunId` — `docs/gotchas/run-id-dot-validation-mismatch.md`: a value produced by one allowlist and consumed by another must use the same function).

- [ ] **Step 7: Add the CLI verbs**

In `src/index.ts`, extend `parseCli` with `report run <runId>` and `report qualify [--from <sha>] [--to <sha>]`, printing the Markdown to stdout. Follow the existing `orchestrate`/`serve` parsing style; reject a missing `runId` with a usage error exactly like `orchestrate` does for a missing intent.

- [ ] **Step 8: Build and verify the whole suite**

Run: `npm run build && npm run build:ui && npx vitest run && npm run typecheck`
Expected: all green. Both bundles must be rebuilt before any live check — a UI-only build leaves the served daemon stale (`docs/gotchas/stale-dist-backend-after-ui-only-build.md`).

- [ ] **Step 9: Commit**

```bash
git add src/report/report-service.ts src/report/report-service.test.ts src/composition/root.ts src/api/server.ts src/index.ts
git commit -m "feat(report): auto-write execution reports, report endpoints and CLI"
```

---

### Task 10: Live proof on the polygon

Unit tests cannot prove this feature: every prior gate feature in this repo that shipped on self-authored fixtures was wrong in production in a way the fixtures could not express (`docs/gotchas/agent-ci-ndjson-keyed-by-event-not-type.md`, `docs/gotchas/llm-retitle-breaks-task-level-dedup.md`). The proof here is that the two numbers **appear and disagree**: a gate green on the added lines while the file it touched still carries pre-existing findings.

**Files:** none (operations)

- [ ] **Step 1: Prepare the polygon**

`D:\Projects\wordpress\woodev-shipping-plugin-test`, on `autodev/main`, tree clean, profile `wordpress-woocommerce@2` attached. Turn `gate.agentCi.enabled` OFF for the run — agent-ci cannot run on native Windows (`docs/gotchas/agent-ci-not-runnable-on-native-windows.md`) — and restore it afterwards.

- [ ] **Step 2: Run one real task in the FOREGROUND**

Run: `node dist/index.js run --once` from the project directory. Foreground, not backgrounded — a backgrounded run gets killed during the nested model spawn (`docs/gotchas/orchestrate-background-run-killed.md`).

- [ ] **Step 3: Verify the ledger**

Read `.autodev/runtime/<taskId>/evidence.json`. Confirm: `outcome` matches what actually happened, `commit` is the real hash, `profile_gates` contains an entry per gate the profile declares — **including any that were skipped, with a reason**.

- [ ] **Step 4: Verify the Execution Report**

Run: `node dist/index.js report run <runId>`. Confirm it names the tasks, the rounds and the token totals, and says nothing about findings.

- [ ] **Step 5: Verify the Qualification Report — the disagreement**

Run: `node dist/index.js report qualify`. Confirm: section 1 lists the phpcs gate as proven on the lines the change added; section 3 names the same file's pre-existing findings as debt. **Both numbers must appear and must differ.** If section 3 is empty, the report is not yet honest — investigate before proceeding.

- [ ] **Step 6: Record the evidence in the session log**

Paste the two reports' summary lines into the session notes as the live proof, per `PRINCIPLES.md` #13 (evidence, not assertion).

---

## Review gate (mandatory, per `AGENTS.md`)

After Task 9 and again after any in-place fix: an independent **codex `gpt-5.6-luna`** review of the full diff. Pin the model. Run it directly rather than through the subagent — `cat prompt.txt | codex exec --model gpt-5.6-luna --skip-git-repo-check -` is synchronous and leaves no stale registry entry (`docs/gotchas/codex-cancel-broken-under-git-bash.md`), and codex cannot read files on Windows, so paste every reviewed file **whole** into the prompt.

Ask the critic for `[critic/validated-one-string-used-another]` **by name**: this change introduces a new normal form (`ProfileGateRecord`) and a new persisted shape, which is exactly where that defect family has appeared seven times in this repo.

Re-critic every in-place fix. Never self-certify.
