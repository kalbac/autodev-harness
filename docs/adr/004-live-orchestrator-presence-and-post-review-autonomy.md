# 004 — The orchestrator is a live presence; autonomy is post-review, bounded by the deterministic gate

**Status:** accepted (operator sign-off, s39 2026-07-12 — doctrine agreed in a dedicated direction session)
**Date:** 2026-07-12
**Refines:** `003-roles-are-a-configurable-vendor-matrix.md` (R1 — the four orchestrator
capabilities; R4 — one long-lived per-project orchestrator). Does not supersede it — R1's
enforcement boundary is explicitly re-affirmed here. Extends the orchestrator from a
one-shot decompose function into a persistent, narrating, (eventually) self-deciding agent.

## Context

s38 shipped agent-ci observability and the operator confirmed the gate demonstrably catches
real bugs — the project's thesis ("never let agents merge bullshit") is **achieved** in
practice. But the operator opened s39 with two structural complaints:

1. **The harness feels "not alive."** Launch → 10–15 s of dead air → a transactional modal →
   more silence → an inspector that displays state but does not narrate. The original
   autodev-loop felt alive because a live LLM orchestrator (the operator's Claude Code
   session) was *in* the loop — watching, deciding, and reporting continuously.
2. **The name is "autodev", yet the harness cannot run unattended.** The aspiration behind
   the name: give an intent in the evening, return in the morning to real progress. Today
   any open question becomes a blocking escalation; work that could have continued waits
   hours for a one-word answer the agent could often have decided itself. The operator's
   extended slogan: **"Stop babysitting and never let agents merge bullshit."**

The s39 diagnosis: **both symptoms share one root cause.** When the loop was wrapped into
the harness, the orchestrator was reduced to a *staged, terminating pipeline*
(`handleIntent`: snapshot → decompose → validate → enqueue → return). The intelligence that
made the original feel alive (narration) and finish jobs (goal pursuit, in-flight decisions)
was amputated in the same cut. The four wins the harness was built for (auto-orchestration,
universality, multi-OS, visibility) never required that loss — it was accidental.

A validating observation from the session itself: the operator noted that this session's
recommendations matched his preferences "100%". That was not guessing — his preferences are
*written down* (memory files, docs, prior ADRs) and were read before deciding. Explicitly
recorded intent turns guessing into reading. This is the mechanism the doctrine below
institutionalizes as the per-project "north star".

## Decision

**The harness gets a persistent orchestrator presence per project, and its autonomy model
flips from pre-approval to post-review — with the deterministic gate unchanged as the
mechanical floor.** Six tenets:

1. **One component, two modes.** Liveness (attended) and autonomy (unattended) are the same
   missing component, not two features. The same persistent orchestrator is a **narrator**
   when the operator is present (streaming prose, no dead air) and a **worker** when absent
   (decides, journals, reports in the morning).
2. **Pre-approval → post-review.** Default agent behavior changes from "unsure → ask → wait"
   to "unsure but reversible → decide, journal the decision, continue". The operator reviews
   a **decision journal** after the fact instead of unblocking a queue of questions. The
   deterministic gate is what makes this safe: a wrong autonomous decision can waste tokens,
   never merge bullshit.
3. **Three decision classes.** At every fork the orchestrator classifies:
   - **(1) Decide silently** — reversible, within intent, any reasonable option is fine
     (naming, ordering, retry strategy, model bump). One journal line.
   - **(2) Decide and flag** — reversible but the operator might have chosen differently
     (ambiguous-intent interpretation, scope trims). Journal entry states the decision, the
     reason, and that it is cheap to revert.
   - **(3) Block** — irreversible or expensive (external effects: publish/deploy/money/data
     deletion), scope changes (×N bigger than asked), and the operator's taste zones
     (UI/UX decisions — an empirically confirmed blind spot). Blocking parks **that task
     only**; the rest of the queue continues; the question goes to a batched report (or a
     future push channel), never a silent pipeline stall.
   Litmus: *"would the operator's answer change what I do next, AND is a wrong guess
   expensive to undo?"* Both yes → class 3. Otherwise decide.
4. **North-star check before self-deciding.** Every registered project gets a short concept
   anchor document (what it is, why, what it must do, what it must never do — created at
   onboarding or in the first orchestrator conversation). The rule the operator set: *"if
   unsure, verify the decision does not pull the work off the project's core concept."*
   Class-1/2 decisions must be checkable against the north star; if the north star is
   silent or contradicted, the fork escalates to class 3. This is the anti-drift critic at
   decision granularity; the run-level intent-vs-cumulative-diff check (FUTURE-BACKLOG
   "anti-drift critic") becomes **mandatory** once unattended operation ships — it is what
   catches "confidently building the wrong thing" over a long night.
5. **Overnight is an explicit mode, not magic.** Autonomy level is a function of **operator
   presence**, toggled explicitly: a single global switch in the top bar (presence is a
   property of the operator, not of a project; optional "until HH:MM"). Attended: the
   orchestrator asks more freely (asking is cheap, and the conversation IS the product
   experience). Overnight: class 2 folds into self-decide, class 3 shrinks to strictly
   irreversible + taste zones, the morning report becomes mandatory. Per-project overrides
   only if a real need appears later.
6. **The gate boundary does not move.** adr/003 R1 is re-affirmed verbatim: the orchestrator
   touches enforcement only via enqueue / trigger / read / report. All new autonomy lives
   **above** the gate (re-plan, enqueue more work, decide "not done yet", park a task) and
   never through it (no skipping the critic, no forcing a commit). "Stop babysitting" is
   only honest because "never merge bullshit" stays mechanical.

## What this does NOT change

- The enforcement substrate (worktree isolation, dirty-file fence, machine gate, independent
  critic, commit-after-gate) — untouched, per adr/003 R1.
- The file-blackboard as single source of truth — new artifacts (threads, decision journal,
  north star) are blackboard files.
- The role matrix (adr/003 R3) — the narrator/decider is the configured `orchestrator` role,
  whatever model fills it.
- Verdict/escalation semantics of the existing gate — escalations gain new *routing*
  (park + batch instead of stall) in a later slice, not new meanings.

## Consequences

- **s40 builds the attended half** — thread-based chat as the project's main screen with a
  streaming, narrating orchestrator presence (spec:
  `docs/superpowers/specs/2026-07-12-live-orchestrator-attended-presence-design.md`).
  The pre-launch ChatModal dies; threads persist on the blackboard.
- **s41+ brainstorms the unattended half** on top of this ADR: decision classes + journal,
  overnight toggle semantics, park-don't-stall escalation routing, morning report,
  north-star document at onboarding, mandatory anti-drift check. Each gets its own
  brainstorm → spec → plan cycle.
- The narrator architecture chosen for s40 (event-driven one-shot narration over persisted
  threads) is deliberately the same machinery a morning report needs — phase 2 reuses it
  rather than replacing it.
- The slogan extends: **"Stop babysitting and never let agents merge bullshit."**

## Related

- `003-roles-are-a-configurable-vendor-matrix.md` — the role model + R1 boundary this builds on.
- `docs/superpowers/specs/2026-07-12-live-orchestrator-attended-presence-design.md` — the s40 slice.
- `docs/VISION.md` — mission anchor (slogan extended by this ADR).
- `docs/FUTURE-BACKLOG.md` — "Orchestrator CHAT" (superseded by this doctrine + the s40 spec)
  and "Anti-drift critic" (upgraded to mandatory-for-autonomy).
