# `[rework/reply-b-poisons-maxrounds-exhausted-task]`

**Tag:** `[rework/reply-b-poisons-maxrounds-exhausted-task]`
**Found:** s43 (2026-07-16), during the blocked-state live-prove.

## What happens

Reply **B** (reject & rework) on an escalation that was raised by **round/attempt
exhaustion** (the worker failed the critic `maxRounds` times) does NOT give the worker
another turn — the conductor's poison-pill guard **immediately re-escalates the task as
`poison`** (→ `quarantine`, a terminal state) the moment the reply-B drain re-claims it,
with no new worktree and no worker spawn.

Live-proven sequence (s43, `pickup-cart-handling-fee`, real daemon):
- `23:26:41 [ESCALATE] pickup-cart-handling-fee (blocked)` — escalated after rounds 0/1/2 all
  returned non-clean (attempt budget exhausted).
- operator reply **B** → `moved escalated/ -> pending/` → `onReplyRework` fires the drain.
- `23:28:23.542 [ESCALATE] pickup-cart-handling-fee (poison)` — **~80 ms later**, the drain
  re-claimed the task and the conductor re-escalated it as `poison` → `quarantine`. No worker ran.

Contrast: in s42 the `dhl-express-cart-fee` task escalated after a **single** round
(`disagreement`, immediate contract-risk escalation), so its attempt budget was NOT exhausted →
reply-B genuinely re-ran the worker (which then converged to `clean` → DONE). So reply-B rework
works for a single-round / immediate escalation, but is a **no-op-then-poison** for a
maxRounds-exhausted one.

## Why it matters

The reply-B "rework" affordance (and the s42 `[rework/reply-b-drops-critic-feedback]` fix that
carries the critic's objection to the re-run) implies "the worker gets another try with the
feedback." For a **round-exhausted** escalation that promise is broken: the operator clicks
"reject & require rework" and gets a terminal `error`/quarantine instead of a rework, because the
attempt/round counter is **not reset** on reply-B. The UI reads as if the rework failed instantly.

This is **conductor attempt-budget behaviour**, NOT a blocked-state defect — the s43 blocked-state
narrator handled it correctly (thread went `blocked` → reply-B re-armed it `running` → the poison
→ quarantine made the run terminal → narrator set `error` + stopped, no wedge).

## Fix — RESOLVED s44

Reset the task's attempt budget when the operator explicitly replies **B** (rework). The reply
handler (`src/api/server.ts`, the `POST /escalations/:id/reply` choice-B branch) now calls
`repo.setAttempts(id, 0)` right after the successful `escalated → pending` move and BEFORE the
`onReplyRework` drain trigger, so the re-claim increments `0 → 1` (under `cfg.loop.maxAttempts`)
and reaches the worker instead of tripping the poison-pill. Scoped to choice **B** + a real move
(never **A** → quarantine is terminal, never the ENOENT drift no-op); best-effort like the
adjacent hook guard (a `setAttempts` failure never breaks the decided 200). The automatic in-loop
retry poison-pill is unchanged — only the deliberate operator "try again" signal resets the budget.
Covered by 2 unit tests (B resets to 0 / A leaves it untouched) + a real repo+scheduler integration
test (reply-B on an attempts=maxAttempts task re-claims fresh, not poisoned). Fix landed on the
`gpt-5.6-luna`-gated s44 branch and live-proven through the daemon+browser.

## Related

- [[reply-b-rework-drops-critic-feedback]] — the s42 fix this partially undercuts for the
  round-exhausted class.
- [[escalated-run-not-terminal]] — the blocked-state narrator (s43) that correctly handled the
  resulting terminal.
- [[replied-escalation-holds-filelock]] — the reply-A/B queue-transition semantics.
