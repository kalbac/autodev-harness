# `[conductor/gate-retry-carries-no-feedback]`

> A gate `RETRY` sends the worker back with **no information about why the gate
> failed**, so it reproduces the same diff until its attempt budget is exhausted.
> Pre-existing (it applies to `checkCommand` too); found s51 because profile gates
> make it the common case rather than a rare one.
>
> **RESOLVED s51** — see "How it was fixed" at the bottom. Live-proven: a task that
> would previously have burned its whole budget now converges in **one** retry.

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

## How it was fixed (s51)

Built as planned, with two corrections reality forced:

1. Each gate step's runner returns its combined stdout+stderr; `runGate` formats
   every failing step into one bounded document (`src/gate/gate-feedback.ts`).
2. It is persisted through an injected `writeGateFeedback` dep called **exactly once
   per gate run, at the decisive exit** — the document when the run had failures,
   `null` (an actual file DELETE, not an empty write) when it did not. That shape is
   what makes the artifact always mean "what the most recent gate run found", so it
   cannot go stale the way a per-round write does
   (`gotchas/per-round-overwrite-artifact-stale.md`). Deliberately NOT persisted from
   the conductor's RETRY branch: only `runGate` knows which steps failed, and routing
   it through `GateVerdict` would have bloated `gate-verdict.json` with linter output.
3. The conductor reads `gate-feedback.md` at claim time beside `critic-feedback.md`;
   the worker renders it as a **fenced** BEGIN/END section, because a linter report is
   full of markdown headings that would otherwise read as prompt structure.
4. Output is clamped head+tail with the omission stated inline — the head carries the
   first errors, the tail the summary line, and a silent truncation would read as a
   complete report.

**What only the live proof could find:** the first real `gate-feedback.md` was full of
ANSI colour escapes, because PHPCS honours its ruleset's `colors` arg even with no
terminal. The worker's prompt read `ESC[31mERROR ESC[0m`. Fixed by stripping CSI
sequences centrally in the formatter — not by disabling colour per tool, since a gate
is an arbitrary operator command and any future profile that forgot the right flag
would degrade silently. Stripped BEFORE clamping, so invisible bytes cannot eat the
character budget.

**Scope note:** the fix covers all three output-producing steps (`checkCommand`,
`success_commands`, profile gates), not just the profile third — fixing one third
would have been the half-applied fix this repo's critic keeps catching.

**Live evidence:** round 1, a new PHP file drew `Missing file doc comment` +
`Missing doc comment for class` → RETRY with the real report persisted; round 2, the
worker added exactly those two docblocks → gate green → committed `c0fb8de`, and
`gate-feedback.md` was **gone** (the clean run cleared it — the anti-stale property,
verified rather than assumed).

Do NOT "fix" a regression here by feeding the raw exit code into the prompt; an exit
number is not feedback.

## Related

- `gotchas/profile-gates-must-be-diff-scoped.md` — the sibling scoping lesson.
- `gotchas/reply-b-rework-drops-critic-feedback.md` — the same class of defect on
  the escalation-reply path, resolved in s42; this is its gate-side twin.
