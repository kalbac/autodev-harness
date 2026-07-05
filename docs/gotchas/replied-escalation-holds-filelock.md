# `[escalate/replied-holds-filelock]` — a replied escalation is never cleared, and its file_set silently blocks every future same-file run

**Found:** s25 live token-run demo on aurora (2026-07-05).

## Symptom

Trigger a run (UI composer / `POST /orchestrate` / `orchestrate` CLI). Everything *looks* fine:
`orchestrator: decomposing intent` → `enqueueing 1 task(s)` → `triggering a bounded run` →
`orchestrated intent -> 1 task(s) enqueued and triggered`. A run card appears. But then **nothing
happens**: the task sits in `queue/pending/`, `active` stays empty, no worktree is created,
`conductor.log` does not grow by a single line, and a standalone `node dist/index.js --once` exits
`0` in <1s having claimed nothing. `token-usage.json` is never written, so the UI Tokens rail shows
`—`. No error anywhere.

## Root cause

`createScheduler().claimNextTask()` (`src/scheduler/scheduler.ts`) claims a pending task **iff** its
`file_set` is disjoint from the `file_set` of every task in `active` **OR `escalated`** — an escalated
task holds its files exactly like an active one (by design: the file-set lock). And **a replied
escalation is NOT moved out of `queue/escalated/` automatically** — `POST /escalations/:id/reply`
writes a `*.reply.json` but leaves the task file sitting in `escalated/`. So the escalation keeps
holding its `file_set` as a permanent lock. Every later run that targets the **same file(s)** decomposes
and enqueues fine, but `claimNextTask` finds the pending task's `file_set` intersects the stale
escalation's → returns `null` → the bounded run is a silent no-op. There is **no operator-facing signal**
that a resolved-but-uncleared escalation is now blocking the whole loop.

This bit the live demo: aurora's `docs-llmfactory-classdoc-v2` (escalated s14, replied `B`, never cleared)
held `server/app/Services/Llm/LlmServiceFactory.php`; three fresh runs all targeting that same file were
each blocked forever with zero diagnostics.

## Diagnosis checklist

A "decompose OK → task stuck in pending → worker never runs → conductor.log doesn't grow" pattern ⇒
suspect a file-lock, NOT a spawn kill (`[orchestrator/bg-spawn-killed]` looks similar but logs a killed
child). Confirm: `ls .autodev/queue/escalated/` and compare each escalated task's `file_set:` against the
pending task's `file_set:`. Any overlap = the block. `scheduler.listClaimable()` also reports
`blocked_by: escalated:<id>`.

## Workaround (pre-s26, historical)

Before the fix, move the resolved escalation out of `escalated/` to release its lock: `mv
.autodev/queue/escalated/<id>.md .autodev/queue/quarantine/<id>.md` (operator-approved — it alters queue
state). Then the pending task claims and runs normally.

## RESOLVED (s26) — reply-apply transitions the task out of `escalated/`

`POST /escalations/:id/reply` (`handleReply` in `src/api/server.ts`) now moves the replied task out of
`queue/escalated/` via the existing atomic `repo.moveTask`, keyed on the A/B choice:

- **B (rework) → `pending`** — re-queued for another run.
- **A (accept) → `quarantine`, NOT `done`.** The originally-planned target was `done`, but the codex gate
  flagged a **High**: the escalated worker's work was never committed (the gate escalated *instead of*
  committing) and the harness has **no apply-on-accept machinery**, so marking it `done` would falsely
  satisfy a dependent task's `depends_on` (`doneIds`) on work that is absent from the repo. `quarantine`
  releases the file-lock **without** claiming repo-completion — it is neither in the scheduler lock set
  (`active`+`escalated` only) nor in `doneIds`. Operator confirmed A→`quarantine` after the gate finding.

`ENOENT` on the move is tolerated (a `drift-*` escalation has an escalation artifact but no queue task file;
a double-reply already moved it) → still `200`; any **other** move error → `500`, so a still-held lock is
surfaced rather than silently `200`'d. Independent codex GPT-5.5 gate: 1 High + 1 Medium → fixed (A→quarantine
+ a dependency-safety regression test) → **re-critic CLEAN**. Regression tests in `src/api/server.test.ts`
assert a replied escalation leaves `escalated/`, unblocks a same-`file_set` pending task, and does NOT falsely
satisfy a dependent's `depends_on`.

**Known follow-up (non-blocking, codex Low):** `B → pending` re-queues the same task id to run from scratch;
if any stale runtime state (a leftover worktree for that id, a prior `worker-report.md`) survived the
escalation, the re-run could collide. Pre-existing concern, not introduced by this fix; the conductor
recreates the worktree on claim. Backlog if it ever bites.

## Related
- `src/scheduler/scheduler.ts` `claimNextTask` — the file-set lock over `active` + `escalated`.
- `[[orchestrate-background-run-killed]]` — looks similar (task stuck) but is a spawn kill, not a lock.
- `[[worker-report-harvest-worktree-fence]]` — another "task escalates/stalls unexpectedly" conductor gotcha.
