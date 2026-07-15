# Spec — Reply-B rework must carry the critic's objection to the re-run

**Date:** 2026-07-15 (s42, priority #2)
**Resolves:** `[rework/reply-b-drops-critic-feedback]` (s41 finding 1)
**Operator review:** waived (overnight autonomy grant, s42).

## Problem

Escalation reply **B** (reject & require rework) moves the task `escalated/ → pending/`, but
the worker never receives the critic's objection on the re-run, so it reproduces the same diff
and re-escalates. Two compounding gaps in `conductor.ts`:

1. The immediate-escalation branch (`contractRisk` — `touches_contract_zone`, actual touched
   zones, or any non-empty `broken_contracts` — OR `round >= maxRounds`) persists
   `critic-verdict.json` but **NOT** `critic-feedback.md`. So there is no durable objection to
   carry across the escalation → reply-B → re-claim boundary.
2. A re-claimed pending task starts a fresh `runIteration` at `round 0`, and `criticFeedback`
   is read **only when `round > 0`** (`conductor.ts:293-294`). So even if `critic-feedback.md`
   existed, a round-0 re-claim would ignore it.

Compounding UX gap: reply-B does not trigger a run, so the reworked pending task sits inert
until an unrelated `handleIntent` triggers the pool (there is no periodic poll —
`conductor.run` is only invoked per orchestrate / CLI `run`).

## Fix (three parts)

**(a) Persist `critic-feedback.md` on escalation.** In the critic-escalation branch of the
round loop (`conductor.ts` ~439-462), after persisting the decisive verdict, write
`critic-feedback.md` with the same content shape the retry branch uses:
`cr.verdict?.notes ?? "critic returned no parseable verdict; make the smallest, clearest change and retry."`
This makes the critic's objection durable in the per-task `runtimeDir` (which persists across
claims for the same task id).

**(b) Read `critic-feedback.md` at round 0 on re-claim.** Change the worker-feedback read so it
always attempts to read the persisted feedback, not only when `round > 0`:
```ts
const criticFeedback = (await repo.readRuntimeFile(task.id, "critic-feedback.md")) ?? undefined;
```
A fresh task's first claim has no such file → `undefined` (behavior unchanged). A reply-B
re-claim has the persisted objection → the worker prompt injects it (`buildWorkerPrompt` already
renders a "Prior critic feedback" block when `criticFeedback` is provided). Task ids are unique
per decompose, so the only round-0-with-feedback case is a genuine re-claim — no cross-task
bleed.

**(c) Auto-trigger a drain on reply-B (R1-thin).** Add an OPTIONAL `onReplyRework?: () => void`
capability to `ProjectView` (mirrors `onOrchestrate`/`onApplyOnAccept` — unset → no-op, for a
read-only deployment). `handleReply` calls it (fire-and-forget) after a successful **B**-move
only (A → quarantine is terminal, needs no re-run). Wired at the composition root to
`() => { void conductor.run({ drain: true }).catch(() => {}); }`. This is a pure R1 "trigger"
of the already-enqueued pool (the escalated→pending move already did the enqueue) — no
decompose, no gate/worker/critic handle crosses the boundary. Concurrency is safe: `conductor.run`
has no re-entrancy lock, but `claimNextTask` atomically moves `pending → active` (a file rename),
so a racing drain claims nothing and, in drain mode, exits.

## Scope

- `src/conductor/conductor.ts` — parts (a) + (b). The most sensitive file; minimal edits.
- `src/api/server.ts` — the `onReplyRework?` field on `ProjectView` + the fire-and-forget call
  in `handleReply` after a B-move.
- `src/composition/root.ts` — wire `onReplyRework` to a drain trigger.
- Tests: `conductor.test.ts` (feedback persisted on escalation; feedback read at round 0 on
  re-claim → worker prompt carries it), `server.test.ts` (reply-B invokes `onReplyRework`; reply-A
  does not; absent hook is a safe no-op).

## Verification (end-to-end — mandatory)

Unit tests are necessary but not sufficient (self-authored fixtures won't catch the real loop —
same lesson as `[orchestrator/llm-retitle-breaks-task-level-dedup]`). Live-prove the FULL loop on
the real daemon against a real repo, operator-observable path:
1. A task escalates on a critic `broken` verdict → `critic-feedback.md` is written with the
   critic's notes.
2. Reply **B** → task moves to `pending/`, a drain is triggered, the task is re-claimed.
3. The re-run's worker prompt contains the "Prior critic feedback" block (assert on the actual
   spawned prompt / worker-report evidence), i.e. the worker SAW the objection.

Because a real end-to-end daemon run that reaches a clean DONE needs a task that then passes the
(now-narrowed, ADR-005) critic, prove at minimum that the objection reaches the re-run's worker
prompt. Full green-DONE close-out of the loop is proven if reachable without an expensive
unattended live run; otherwise the "objection reaches the worker" proof + unit coverage is the
honest bar, and the green-DONE close-out is flagged for the operator.

## Out of scope

- Enriching the in-loop retry feedback shape (the retry branch already carries notes; keep it
  consistent, do not broaden).
- Any change to A (quarantine) or C (commit-on-accept) semantics.
- No change to the critic, gate, or verdict schema.

## Related

- `docs/gotchas/reply-b-rework-drops-critic-feedback.md`
- `src/conductor/conductor.ts`, `src/api/server.ts`, `src/composition/root.ts`,
  `src/worker/prompt.ts` (renders the feedback block).
