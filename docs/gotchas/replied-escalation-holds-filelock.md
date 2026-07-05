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

## Workaround (until the real fix lands)

Move the resolved escalation out of `escalated/` to release its lock: `mv .autodev/queue/escalated/<id>.md
.autodev/queue/done/<id>.md` (operator-approved — it alters queue state). Then the pending task claims and
runs normally.

## The real fix (scheduled s26 — variant 1)

Applying/closing an escalation reply must transition the task out of `escalated/`: either
`escalated → done` (reply accepted, no further work) or re-queue `escalated → pending` (reply says redo),
mirroring the reply's A/B semantics. Until then a replied escalation is a silent, accumulating file-lock
land-mine. Codex-gate the reply-apply path (it touches queue-state transitions the scheduler reads).

## Related
- `src/scheduler/scheduler.ts` `claimNextTask` — the file-set lock over `active` + `escalated`.
- `[[orchestrate-background-run-killed]]` — looks similar (task stuck) but is a spawn kill, not a lock.
- `[[worker-report-harvest-worktree-fence]]` — another "task escalates/stalls unexpectedly" conductor gotcha.
