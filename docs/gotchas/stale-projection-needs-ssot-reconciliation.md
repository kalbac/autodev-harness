# A downstream projection can lie; only the SSOT can arbitrate

**Tag:** `[report/stale-projection-vs-ssot]`
**Found:** s52 (the two reports), via codex `gpt-5.6-luna` re-critic rounds 2-3.

## The trap

The evidence ledger (`runtime/<taskId>/evidence.json`) is a per-task record written
once per conductor iteration and read back by both reports. It is a **downstream
projection** of the blackboard, not a source of truth (Principle 11).

A fail-soft writer (it must never fail a task, H6) plus a "clear the old record
before the iteration's work" step looks like it guarantees freshness: a failed write
leaves the record *absent*, which the store reports honestly as missing evidence
(H1). It does **not**. If BOTH the pre-work clear and the post-work write fail on one
iteration (the runtime dir became unwritable mid-run — the same failure that silently
drops `token-usage.json` etc.), a **prior iteration's record survives**. A task that
committed can still carry an `abandoned` record, and a report that trusts the
projection repeats the lie.

**No file-only scheme closes this.** If the filesystem rejects both the remove and
the write on that path, nothing stored in that file can be made fresh. The critic
kept re-finding a narrower version of the same hole (R2: the write-fail window; R3:
the double-fail window) because each fix was another file-level best-effort layer.

## The fix — reconcile against the single source of truth

The blackboard (the task queue) is authoritative; the projection is not. So at
**read** time, the report reconciles each record's outcome against the task's **live
queue state**. On a positive contradiction (a locatable queue that differs from the
one the record's outcome implies), the queue wins: the live outcome is reported, the
record's iteration-derived detail is dropped, and the line is flagged
`evidence_stale`. A `null` (undeterminable) live state is **not** a contradiction —
fabricating staleness from missing information would be its own fail-open.

This is Principle 11 made mechanical: a projection may never override the SSOT, and
the only place that can be enforced is where the two are compared.

## The asymmetry that follows

Reconcile against the RIGHT source of truth for the report's subject. The **Execution
Report** is about task outcomes -> reconcile against the live task queue. The
**Qualification Report** is about *commits* ("what did commit `<abc>` prove") ->
reconcile against git history (`git rev-list`), which is already its selection basis,
and do NOT consult the task queue. A `committed` record is terminal (`done/`, no
transition back out), so there is no stale-credit path to reconcile there. Threading
task-location state into a commit-scoped report would be a category error — a codex
finding declined on exactly this ground, and a later round agreed.

## Also: reject the impossible at the fail-closed boundary

A projection read from disk must be treated as potentially corrupt. Two contradictions
the schema now rejects (making the record `unreadable`, which the report names rather
than trusts), because each would silently read as coverage:
- `findings.total < in_diff` -> a NEGATIVE pre-existing debt that the `debt > 0` test
  drops, hiding real debt.
- a `commit` hash on a non-`committed` outcome -> the Qualification Report credits "a
  commit in range" as proof the change landed; a non-committed record carrying one
  forges product proof. The conductor sets `commit` on exactly the `committed` exit,
  so `committed <=> commit !== null` holds for every honest record — enforce it.

## Related

- `docs/PRINCIPLES.md` #11 (single source of truth), #10 (fail toward the safe state).
- `docs/gotchas/per-round-overwrite-artifact-stale.md` — the sibling "latest-value
  artifact goes stale" family; write-or-clear closes the single-failure case, SSOT
  reconciliation closes the double-failure case.
- `docs/superpowers/specs/2026-07-22-two-reports-design.md` — H7/H8/H9.
