# `[rework/reply-b-drops-critic-feedback]`

**Escalation reply "B" (reject & require rework) resets the task to `pending` but never conveys the critic's objection to the next run — so the worker repeats itself and re-escalates identically.**

Two independent gaps compound (both in `src/conductor/conductor.ts`):

1. **The immediate-escalation branch does not write `critic-feedback.md`.** When the critic returns non-clean AND `contractRisk` is true (`task.touches_contract_zone || zonesTouchedInDiff().length || cr.verdict.broken_contracts.length > 0`), the conductor escalates at **round 0** (`if (contractRisk || round >= maxRounds)`), persisting `critic-verdict.json` but NOT `critic-feedback.md`. `critic-feedback.md` is only written on the NON-decisive retry branch (round < maxRounds AND no contract risk).

2. **A re-claimed pending task starts at `round 0`, and `criticFeedback` is read only when `round > 0`:**
   ```
   const criticFeedback = round > 0 ? (await repo.readRuntimeFile(task.id, "critic-feedback.md")) ?? undefined : undefined;
   ```
   `round` is loop-local, initialized to 0 on every `runIteration`. Reply-B moves the task `escalated/ -> pending/` (gotcha `[escalate/replied-holds-filelock]`) but the next drain claims it fresh at round 0 → `criticFeedback` is `undefined` even if the file existed.

**Net:** for a contract-risk escalation (the common case — any new public API, load-order, etc.), reply-B rework is non-functional: the worker never sees why it was rejected, reproduces the same diff, and re-escalates. The operator's "require rework" does nothing useful. Also note reply-B does NOT auto-trigger a drain — the task sits inert in `pending` until an unrelated trigger.

**Candidate fix:** on escalation, ALWAYS persist the verdict notes to `critic-feedback.md` (not only on the retry branch); and on a fresh claim of a task that has a prior `critic-feedback.md`, feed it into the worker prompt (round-0 too), or carry a persisted `attempts`/`lastVerdict` that forces `criticFeedback` on re-claim. Live-prove the full reply-B → rework → clean loop, not just the unit path.

Found s41 (live-prove of a real WC_Integration task; the operator chose reply-B and the rework would have looped).

## Related
- [[replied-escalation-holds-filelock]] — the sibling reply-B mechanics (moves escalated→pending).
- [[critic-before-ci-blocks-testless-repos]] — the same session's critic-gate finding.
