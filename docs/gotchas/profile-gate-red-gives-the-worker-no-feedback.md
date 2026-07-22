# `[conductor/gate-retry-carries-no-feedback]`

> A gate `RETRY` sends the worker back with **no information about why the gate
> failed**, so it reproduces the same diff until its attempt budget is exhausted.
> Pre-existing (it applies to `checkCommand` too); found s51 because profile gates
> make it the common case rather than a rare one.

## What happens

`conductor.ts`'s decision branch is, in full:

```ts
if (gv.decision === "RETRY") {
  await repo.moveTask(task.id, "active", "pending");
  return { claimedTaskId: task.id, committed: false, rateLimited: false };
}
```

No artifact is written. On the next claim the conductor reads
`critic-feedback.md` — which is produced **only** on the critic/escalation paths
(`[rework/reply-b-drops-critic-feedback]`), never by a gate RETRY. So the worker
starts the new round with exactly the context it had before, reproduces
substantially the same diff, and the gate fails again. The loop ends when the
attempt budget runs out and the task escalates.

The actionable content — the PHPCS report naming file, line and sniff — is
produced by the tool, discarded by `runProfileGates` (only the exit code is kept),
and never reaches either the worker or the operator. The verdict says only
`profile gate 'phpcs' FAILED (exit 1)`.

## Why this is not a fail-OPEN

Nothing wrong merges. The task burns rounds and then parks for the operator, which
is the safe direction (Principle 10). It is a *wasted-work and observability*
defect, not a correctness hole — which is why v1 shipped with it named rather than
blocked on it.

## Why it matters more for profiles than for `checkCommand`

A project-level `checkCommand` is usually green and rarely the thing that fails. A
linter gate is red **often and legitimately**, and its output is precisely the
information the worker needs. A feedback channel that is merely nice-to-have for
`checkCommand` is load-bearing for a profile.

## The shape of the fix (not built in v1)

1. `runProfileGates` captures each gate's stdout/stderr instead of discarding it.
2. On a RETRY, persist it to a runtime file (`gate-feedback.md`, sibling of
   `critic-feedback.md`).
3. The round-0 read that already picks up `critic-feedback.md` unconditionally
   picks this up too, so the next round's worker sees the actual sniff messages.
4. Bound the captured output — a linter can emit megabytes.

Do NOT "fix" this by feeding the raw exit code into the prompt; an exit number is
not feedback.

## Related

- `gotchas/profile-gates-must-be-diff-scoped.md` — the sibling scoping lesson.
- `gotchas/reply-b-rework-drops-critic-feedback.md` — the same class of defect on
  the escalation-reply path, resolved in s42; this is its gate-side twin.
