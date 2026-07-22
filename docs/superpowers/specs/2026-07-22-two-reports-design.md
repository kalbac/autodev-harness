# Two Reports — Harness Execution vs Product Qualification (design)

> Spec — s52. Authored 2026-07-22.
> Next link in the `wiki/architecture-review-external-2026-07.md` chain:
> `Authority Model → Profiles → **two reports** → Evaluation Corpus`.
> Anchors: `PRINCIPLES.md` #13 (evidence, not assertion), #15 (the gate proves only
> formalized properties), #10 (fail toward the safe state).

## The problem

A green run and a good product are different claims, and the harness currently
conflates them by making neither. There is no end-of-run report at all: a run
manifest holds `{runId, intent, taskIds, at}` and nothing else, and every judgement
the harness makes — the critic verdict, the four gate greens, the per-gate profile
results — is either collapsed into a boolean, rendered to transient text, or written
to a log line and lost.

The external review's instruction is to separate the two claims and never mix them:
a **Harness Execution Report** (orchestration, critic, gates, budgets) and a
**Product Qualification Report** (requirements, compatibility, security, release
artifact).

The design constraint that makes this non-trivial is honesty about scope. s51
measured it: the WPCS ruleset reports **7069** errors tree-wide and **8** on the file
a task actually changed. Line-scoped gates are what made the gate usable — the worker
is judged on the lines it wrote. The consequence is that a hundred green runs are a
hundred proofs about *diffs* and zero proofs about the *product*. A qualification
report that reads "this plugin is qualified by `wordpress-woocommerce@2`" would be
exactly the overclaim `PRINCIPLES.md` #15 forbids.

## Decisions

**D1 — Different readers, different lifetimes.** The Execution Report is per-run,
for the harness operator, and it goes stale within a day: it is diagnostics. The
Qualification Report is per-commit, outlives any single run, and addresses an
external reader: it is the asset. Two tabs of one post-run screen would collapse the
distinction back into cosmetics within a session.

**D2 — The Qualification Report is scoped to a commit and states its own limits.**
Rejected: a separate whole-tree qualification run (red forever on any real legacy
codebase — the 7069 wall; survivable only with a baseline file, and a baseline *is*
an oracle, rejected on principle in s51). Rejected: a coverage-percentage ledger —
there is no honest definition of "this file is covered" when a file was only ever
proven one diff at a time; that metric belongs to the Evaluation Corpus.

**D3 — Reports are assembled, never maintained.** The only new persistent state is a
per-task evidence record. Both reports are pure functions over the set of evidence
records they select. A report is therefore reproducible, and a bug in a renderer is
never a bug in the record.

**D4 — The Execution Report is written automatically; the Qualification Report is
produced on demand.** A claim about the product should be a deliberate act, not a
side effect of a run finishing.

## Architecture

```text
conductor / gate ──writes──▶ runtime/<taskId>/evidence.json   (the ledger)
                                      │
                        ┌─────────────┴──────────────┐
                        ▼                            ▼
             execution-report.ts            qualification-report.ts
             (select: one runId)            (select: a commit range)
                        │                            │
                        └──────────▶ render.ts ◀─────┘
                                    (json = artifact, md = rendering)
```

### The evidence ledger

One record per task, at `<stateDir>/runtime/<taskId>/evidence.json`. It captures what
the harness already decides but currently discards.

```jsonc
{
  "schema": 1,
  "task_id": "…", "run_id": "…" | null,
  "title": "…", "type": "…",
  "declared": {
    "file_set": ["…"],
    "acceptance": ["…"],
    "success_commands": ["…"]
  },
  "profile": { "id": "wordpress-woocommerce", "version": 2 } | null,
  "outcome": "committed" | "quarantined" | "escalated" | "abandoned",
  "commit": "<sha>" | null,
  "escalation": { "type": "…", "reason": "…" } | null,
  "rounds": 2, "attempts": 1,
  "started_at": "…", "ended_at": "…",
  "critic": { "verdict": "clean"|"broken"|"uncertain", "confidence": 0.82 } | null,
  "gate": {
    "decision": "COMMIT"|"RETRY"|"ESCALATE",
    "composer_green": true, "success_green": true,
    "agent_ci_green": true, "profile_green": true,
    "constitution_touched": ["…"],
    "zones": [{ "id": "…", "guarded": true, "mutation_passed": true, "blessed": false }],
    "changed_files": ["…"]
  } | null,
  "profile_gates": [
    { "id": "phpcs", "status": "green"|"red"|"skipped",
      "exit_code": 1 | null, "skip_reason": "no changed file matched files: **/*.php" | null,
      "scope": "changed-lines" | "changed-files" | "whole-project",
      "files": ["…"],
      "findings": { "total": 8, "in_diff": 0, "unattributed": 0 } | null }
  ],
  "tokens": { "worker": { … }, "critic": { … } }
}
```

Three fields carry the design's weight:

- **`profile_gates[].status: "skipped"` with a `skip_reason`.** Today a skipped gate
  exists only as an INFO log line (`root.ts:542`). A skipped gate bounds what the
  verdict covers, so it is the primary input to the "not proven" section. Without it
  the Qualification Report is marketing.
- **`profile_gates[].scope`.** Derived from the gate's declaration: a gate with
  `report:` is `changed-lines`, a gate with `files:` but no `report:` is
  `changed-files`, a gate with neither is `whole-project`. This is the field the
  Qualification Report sorts on, and it is what keeps a line-scoped proof from being
  read as a product-wide one.
- **`findings.in_diff` vs `total`.** A gate can legitimately be green with a non-zero
  exit code when every finding sits outside the diff. The report must show both
  numbers, because their difference *is* the untouched debt. This requires the gate
  to record the tool's count *before* diff-filtering as well as after: `findings` as
  the gate hands it over is already the filtered set, so a ledger storing only that
  would make the two numbers equal by construction and the debt invisible — a
  line-scoped green would silently read as a whole-file proof. When a run never
  measured the full count (a gate that exited 0 and was therefore never parsed), the
  total is recorded as *not measured* rather than as `0`: claiming a file is clean
  because nothing looked at it is the fail-open this whole feature exists to avoid.

Writing is **fail-soft**: an evidence write that throws logs a WARN and never fails a
task. A report assembled over records that are missing or unreadable says so
explicitly (see H1).

### Harness Execution Report

Selected by `run_id`. Written automatically when a run reaches a terminal state —
reusing the narrator's existing terminal predicate (all tasks terminal-or-escalated,
`gotchas/escalated-run-not-terminal.md`), so an escalation-parked run still produces
a report instead of waiting forever.

Written to `<stateDir>/reports/run-<runId>.json` and `.md`. Contents:

- **Identity** — run id, intent, wall-clock start/end, task count, profile in effect.
- **Per task** — outcome, commit, rounds, attempts, critic verdict + confidence, gate
  decision with the failing greens named, escalation type, tokens.
- **Rollups** — first-pass gate rate, retries-to-convergence, escalations by type,
  total worker/critic tokens by model. These are the three properties s51 named as
  newly measurable; the Evaluation Corpus later consumes them, which is why they are
  computed here rather than left to a reader.
- **Coverage of its own evidence** — how many of the run's tasks produced a record.

It states nothing about product quality. That separation is enforced structurally:
the Execution Report renderer never reads `profile_gates[].findings`.

### Product Qualification Report

Selected by a commit range. Selection is explicit: the report takes the set of
commits from `git rev-list <from>..<to>` (default `<to>` is `HEAD`, default `<from>`
is the repository root commit) and keeps every evidence record whose `commit` is in
that set. A record with `commit: null` (escalated or quarantined — nothing landed) is
**not** selected as evidence of the product, but its task's unproven `acceptance[]`
entries are still reported, since the operator asked for them and never got them.
Produced on demand — a CLI verb and an endpoint — never on a timer.

Header: profile `id@version`, harness version, commit range, evidence completeness.
Then exactly three sections, in this order:

1. **Proven on change.** Per gate with `scope: changed-lines` or `changed-files`: the
   commits and files where it ran green. Each entry states its own scope in words —
   "the lines this change added", not "this file".
2. **Proven whole-product.** Only gates with `scope: whole-project` (today
   `composer validate`). Small on purpose; growing it is the profile's job, not the
   report's.
3. **Not proven.** The longest section by design, assembled from:
   - every skipped gate, by id and skip reason;
   - every `acceptance[]` string not covered by a `success_command`;
   - pre-existing findings outside the diff (`total − in_diff`), as the named debt;
   - tasks with missing or unreadable evidence;
   - a standing entry naming what the profile does not check at all (the analyzer
     toolchain is project-controlled — the residual named in `CURRENT-STATE.md`).

## Honesty invariants

These are the acceptance criteria of the feature, and each gets a test.

- **H1 — missing evidence is `unknown`, never `pass`.** A task whose record is absent
  or unparseable is counted in "not proven" and named in the report's completeness
  line. (`PRINCIPLES.md` #10.)
- **H2 — a skipped gate is always visible.** It appears by id and reason in section 3.
  A report that cannot determine whether a gate ran treats it as skipped.
- **H3 — no bare verdict.** The Qualification Report never emits "qualified" as a
  standalone word. Its summary line always carries profile, range, and the three
  counts. A rendering test pins this.
- **H4 — unchecked acceptance is a gap, not silence.** Free-text `acceptance[]` lands
  in section 3 unless a `success_command` covers it.
- **H5 — the two reports never share a section.** The Execution renderer does not read
  findings; the Qualification renderer does not read tokens, rounds, or attempts. A
  test asserts each renderer's output is free of the other's vocabulary.
- **H6 — evidence never fails a task.** A throwing writer logs and continues.

## Modules

| Module | Responsibility |
|---|---|
| `src/report/evidence-types.ts` | The record type + a zod schema (fail-closed read) |
| `src/report/evidence.ts` | Build a record from the conductor's decisive state; fail-soft write |
| `src/report/evidence-store.ts` | Read + select records (by run, by commit range); reports "unreadable" distinctly from "absent" |
| `src/report/execution-report.ts` | Assemble the Execution Report document |
| `src/report/qualification-report.ts` | Assemble the Qualification Report document |
| `src/report/render.ts` | Markdown rendering of either document |

Changes to existing code, kept minimal:

- `runProfileGates` (composition root, `root.ts:537-623`) returns per-gate records
  **including skipped ones**, instead of collapsing to one boolean. The record is the
  dep's one and only return shape — not the old shape with optional fields added
  beside it, which would be two normal forms for one value and hence the exact defect
  family `gotchas/validated-one-string-used-another.md` names as this repo's most
  recurring. `runGate` folds only `status === "red"` into `profile_green` (a skipped
  gate must never turn a verdict red) and carries the records on `GateVerdict.
  profile_gates`, which puts them in `gate-verdict.json` for free and delivers them to
  the conductor with no new plumbing. The verdict logic itself is untouched.
- The conductor accumulates a mutable evidence draft during a task iteration; each
  decisive exit records its outcome by assignment, and the record is written **once**,
  in the iteration's `finally`. A write at each exit was rejected: `runIteration` has
  ten decisive exits, so that is ten chances to forget one, and a forgotten exit means
  a silently missing record. This is the same write-once idiom `gate-feedback.md`
  already uses, for the same reason (`gotchas/per-round-overwrite-artifact-stale.md`).
  The draft's default outcome is `abandoned`, so an exit that forgets to set one
  produces an honest "ended without a recorded decision" rather than a claimed success.
- API: `GET /projects/:id/runs/:runId/report` and
  `POST /projects/:id/qualification-report` (a claim is an explicit act, hence POST).
- CLI: `report run <runId>` and `report qualify [--from <sha>] [--to <sha>]`.

UI is out of scope: a designed report surface is its own piece of work, and both
reports are readable through the CLI and the endpoints in the meantime.

## Testing

- Evidence: a record round-trips; an unparseable record reads as unreadable, not
  absent; a throwing writer does not fail the task (H6).
- Selection: a run with a task missing its record reports completeness honestly (H1).
- Profile gates: a skipped gate reaches the record with its reason (H2) — this is the
  regression test for the capture that does not exist today.
- Rendering: the summary line always carries profile + range + counts (H3); the two
  renderers do not leak each other's vocabulary (H5); an `acceptance[]` string with no
  covering `success_command` appears in section 3 (H4).
- Live proof on `woodev-shipping-plugin-test`: a real run produces an Execution
  Report, and a Qualification Report over its commits shows a green line-scoped gate
  in section 1 while the file's pre-existing findings appear as debt in section 3.
  The point of the live proof is that both numbers appear and disagree.

## Out of scope

- Coverage percentages (Evaluation Corpus).
- Compatibility and security facets of a profile — the report has sections for them
  the moment a profile declares such gates; inventing them here would be building a
  renderer for data nobody produces.
- A designed UI surface for either report.

## Related

- `docs/wiki/architecture-review-external-2026-07.md` — the chain this is the third link of.
- `profiles/README.md` — the gate contract (`files`, `report`, `redExitCodes`).
- `docs/PRINCIPLES.md` — #10, #13, #15.
- `docs/gotchas/profile-gates-must-be-diff-scoped.md` — the 7069-vs-8 measurement.
- `docs/gotchas/escalated-run-not-terminal.md` — the terminal predicate reused here.
