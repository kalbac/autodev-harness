# `[autonomy/budget-saga-order]` — a per-task budget spanning two blackboard files can't be atomic; order the saga so every partial failure fails toward LESS spend

**Tag:** `[autonomy/budget-saga-order]`
**Discovered:** s45 (2026-07-17), the overnight-supervisor slice — took **four** codex `gpt-5.6-luna` review passes to converge.

## The trap

The overnight supervisor's auto-rework consumes a per-task **budget** (a counter in
`runtime/<id>/auto-rework-count`) AND triggers work (the `escalated→pending` requeue = a
queue-dir move). Those are **two separate files on the blackboard** with no transaction
around them. Every ordering of "increment the counter" vs "requeue" fails a different way,
and a naive fix for one reintroduces the other:

- **Journal-before-action** → a failed requeue leaves a false "auto-rework done" journal line.
- **Requeue-first, then persist the counter** → no false journal, BUT if the counter write
  *persistently* fails, each new supervisor invocation re-reads the stale (low) count and
  grants a **fresh budget every run** → unbounded cross-run over-budget (the exact thing a
  safety budget exists to prevent).
- **Counter-first, then requeue** → durable budget, BUT if the requeue then fails, the
  counter is already incremented for a rework that never happened → a later run **false-parks**
  the task as "budget exhausted."

There is no ordering that is atomic. codex correctly rejected each single-direction fix.

## The fix (saga + compensation + in-memory tally)

1. **Persist the budget FIRST.** A persistent counter-write failure throws *before* any
   requeue → no rework, no over-budget; the cap stays enforceable across runs.
2. **Requeue inside a try; on failure, COMPENSATE** (roll the counter back to its prior
   value) so the task retries cleanly instead of false-parking. Rethrow the original error.
3. **Advance an in-memory `seen` tally** (per supervise() call) and use
   `max(persisted, seen)` as the effective count — this guarantees loop **termination**
   even if the persisted counter never advances (a silently-no-op write), independent of
   the file layer, and closes the split-read race (reading the count twice).
4. **Journal LAST** — records a *completed* action, never an intent.
5. The rollback's `.catch` must **not be silent** — a double fault (requeue fails, then
   rollback fails) leaves the counter one high (an *early* park); emit a guarded WARN so the
   operator has a signal the runtime store may be damaged. Guard the logger so a throwing
   logger can't mask the original error (`[ts/fail-closed]`).

## Rule of thumb

When a bound/budget spans two non-atomic persistent writes, you cannot make it perfectly
atomic — **pick the safe fail-direction and make every interleaving fall that way.** For a
*safety* budget (bounding unattended spend), the safe direction is toward **LESS** spend: a
partial failure should park early, never grant extra reworks. The requeue (the real
side-effecting action) is the **commit point**; persist the budget before it, compensate on
its failure, and keep an in-memory tally for termination. True atomicity would need a single
transactional state record or a durable outbox — out of scope for a file-blackboard v1, and
the saga ordering is the achievable correctness bar (codex `PASS WITH NITS`).

## Related
- [[never-throws-catch-block-logging]] — the guarded-logger discipline the rollback WARN reuses.
- `docs/superpowers/specs/2026-07-17-unattended-overnight-escalation-handling-design.md` — the slice.
- `docs/adr/004-live-orchestrator-presence-and-post-review-autonomy.md` — the doctrine (tenet 6: autonomy above the gate).
