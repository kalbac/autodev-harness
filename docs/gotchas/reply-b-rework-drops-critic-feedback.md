# `[rework/reply-b-drops-critic-feedback]`

> **RESOLVED s42 (commit `3fd977b`).** Three-part fix: (a) the critic-escalation branch in
> `conductor.ts` now writes `critic-feedback.md` (same content shape as the in-loop retry
> branch) so the objection is durable across the escalation→reply-B→re-claim boundary; (b) the
> worker-feedback read is now **unconditional** (was `round > 0` only), so a re-claimed reworked
> task gets the objection at round 0 — a fresh task's first claim has no file → `undefined`
> (unchanged); (c) `server.ts` + `index.ts` fire a best-effort `onReplyRework()` →
> `conductor.run({ drain: true })` after a reply-B move so the reworked task actually runs
> instead of sitting inert (R1-thin trigger; only for B, only on a real move, guarded against a
> throwing hook). Proven by 3 conductor + 5 server unit tests + a REAL repo+scheduler
> integration test (feedback survives escalated→pending→re-claim) + a live daemon boot-smoke.
> The full LLM reply-B→rework→clean daemon cycle was deliberately NOT run unattended (overnight
> autonomy: stop before expensive unsupervised live runs) — ready for an operator-attended run.

**Escalation reply "B" (reject & require rework) resets the task to `pending` but never conveys the critic's objection to the next run — so the worker repeats itself and re-escalates identically.** (Historical description; resolved s42 — see the note above.)

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
