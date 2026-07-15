# 005 — The critic is a correctness gate; coverage enforcement is the deterministic machine gate's job

**Status:** accepted (operator delegated the decision to the agent, s42 2026-07-15, with an
explicit "veto if the philosophy is misread" checkpoint — not vetoed)
**Date:** 2026-07-15
**Refines:** `003-roles-are-a-configurable-vendor-matrix.md` (R1 — the enforcement boundary
stays mechanical). Narrows the independent critic's remit; does not touch the enforcement
substrate. Resolves the s41 blindspot recorded as
`[gate/critic-before-ci-blocks-testless-repos]`.

## Context

s41 ran the first real task on a real project (`woodev-shipping-plugin-test`, a WooCommerce
plugin with no reachable test harness — its phpunit needs wp-env) and surfaced a structural
problem. The independent adversarial critic (`src/critic/prompt.ts`) HARD-demands a
guard/test for **any** behavioral change ("Only conclude `clean` if you cannot find a broken
contract, **a missing guard**, or a fabricated proof"). The `agent-ci` CI-replay step lives
**inside `runGate`**, and `runGate` runs **only after a `clean` verdict** (`conductor.ts`
round loop `break`s to the gate on clean). Therefore, in a repo with no reachable test
infrastructure, **every feature task escalates before CI ever runs** — only a behavior-neutral
change (a docblock) can pass the critic and reach the gate.

Live evidence (s41, 4 attempts):
- Attempt 1 (`WC_Integration`) → critic `broken 0.78` — a REAL load-order bug (an `add_filter`
  under a load-time `class_exists` can silently skip). A correctness finding.
- Attempt 2 (refined) → critic `broken 0.78` — the file is dead code (nothing requires it). A
  correctness finding.
- Attempt 3 (a **trivial, correct** getter) → critic `broken 0.73` — "missing coverage/guard
  for a new public contract." A **pure coverage demand on correct code.**
- Attempt 4 (a behavior-neutral docblock) → `clean` → gate → agent-ci green 5/5 → DONE
  (`3609a2c`).

The critic blocked correct work (attempt 3) for the one reason that is **impossible to satisfy
in a test-less repo**, while the changes it *should* block (attempts 1–2) were blocked for
**correctness**, not coverage.

## The distinction the old critic conflated

The gate protects against two different things:

| | What it is | Who can verify it |
|---|---|---|
| **Correctness** | this diff works — no regressions, no logic holes, no silent failures, no fabricated proof (a test edited to match a changed value) | an independent adversarial reader (the critic) + agent-ci against the repo's *existing* tests |
| **Coverage** | a NEW test locks the new behavior so a FUTURE change can't silently break it | the deterministic machine gate: declared contract zones (`INVARIANTS.md`) + mutation-verified, operator-blessed guards (`GUARDS.md`) |

The machine gate **already** enforces coverage, and enforces it far more rigorously than an
LLM can: it does not merely ask "is there a test?", it demands a guard that is *mutation-proven*
(goes red on a flipped value) and *operator-blessed*, tied to a *declared* zone. The critic's
blanket "missing guard → not clean" is a fuzzy LLM **duplicate** of that mechanism — cruder
where a zone is declared (the machine gate does it better) and **unverifiable theater** where no
zone/harness exists (even a critic-demanded test cannot be mutation-verified there, so it
proves nothing — yet it blocks correct work forever).

## Decision

**The independent critic is a CORRECTNESS + FABRICATION gate, not a coverage gate. Coverage
enforcement belongs exclusively to the deterministic machine gate (contract zones +
mutation-verified guards) plus agent-ci against the repo's existing tests.**

Concretely, the critic still assumes-broken-by-default and still fails a diff for:
- a **broken contract** (behavior that contradicts an invariant);
- a **fabricated proof** — a test edited to match a changed contract value is itself broken;
- **logic / regression risk** — off-by-one, unhandled edge case, silent failure.

The critic **no longer** fails a diff solely because a correct behavioral change lacks a
**brand-new** test. That is a coverage gap, not bullshit; it is the machine gate's job, and
where no zone/harness exists it is simply unenforceable and must not block correct work. The
critic notes an uncovered behavioral touch in its `notes` (an informational honesty signal so
the operator sees coverage was not locked) — it does not fail the verdict on it.

The operator's lever for "I want coverage enforced here" is unchanged and mechanical: **declare
a contract zone** (`INVARIANTS.md` + a blessed `GUARDS.md` guard). The critic stops
second-guessing that mechanism.

## Why this does not violate "never merge bullshit"

Every category of bullshit the harness exists to stop is still stopped, by the same or a
stronger mechanism:

- **Broken / regressing code** → critic checklist #4 (unchanged).
- **Fabricated proof** → critic checklist #3 (unchanged) — the dangerous "faked a test" case
  stays a hard block.
- **Contract violation** → machine gate zones/guards (unchanged) + critic still identifies
  touched zones.
- **Existing suite regressions** → agent-ci (unchanged).

What is dropped is *only* "you wrote a correct change but did not add a new test for it" — and
*only* has teeth removed where coverage is unverifiable anyway. On the s41 evidence this
change flips exactly attempt 3 (a correct getter) from `broken` to `clean` and leaves attempts
1–2 (real bugs) blocked. "Never merge bullshit" was never "never merge anything unprovable" —
it was "never merge what an independent check flags as broken." A correct change with no
available test harness is not flagged-broken; blocking it forever makes the harness useless on
the large class of real-world repos that lack a reachable test harness (including the
operator's own plugin), for zero safety gain.

This *strengthens* adr/003 R1: enforcement stays mechanical (zones/guards/agent-ci), and the
LLM critic is confined to the adversarial correctness judgment a machine cannot do — instead of
also doing a fuzzy, weaker version of the mechanical coverage check.

## On critic → CI ordering

The s41 handover framed a second option: run CI *earlier / independently* of the critic. This
ADR **rejects reordering.** The perceived ordering problem was a *symptom* of the critic being
unsatisfiable, not a defect in the order. agent-ci is expensive (spins Docker, replays real
CI) and off by default; the critic is cheap. Running CI before the critic would burn Docker on
every retry round, including rounds the critic would reject anyway. Once the critic stops
demanding the impossible, correct features reach `runGate` and agent-ci runs exactly once, on
the final clean diff — which is the correct cost ordering. CI stays inside `runGate`, after
`clean`.

## What this does NOT change

- The enforcement substrate — worktree isolation, dirty-file fence, machine gate
  (`runGate`: check + success + agent-ci + zones/guards), commit-after-gate — untouched, per
  adr/003 R1.
- `conductor.ts`, `gate.ts`, the round-loop structure, the step order, the config schema —
  all untouched. This is a **prompt-only** behavioral change to `src/critic/prompt.ts`.
- The machine gate's own zone-coverage escalation (`gate.ts` decision: unguarded declared zone
  → ESCALATE) — unchanged. A repo that DECLARES a zone still gets mechanical coverage
  enforcement.
- Verdict schema, escalation semantics, agent-ci semantics — unchanged.

## Consequences

- `src/critic/prompt.ts` is the single production file changed: remove "a missing guard" from
  the clean-blocker list; reframe checklist #2 from decisive to diagnostic; add an explicit
  "coverage of new behavior with a new test is the machine gate's job, not yours; a correct
  change lacking a brand-new test is `clean`" statement; keep the fabricated-proof block.
- `src/critic/prompt.test.ts` pins the new contract (no "missing guard" clean-blocker; the
  machine-gate-owns-coverage statement present; fabrication + logic blocks retained).
- End-to-end verification for a prompt change is a **real critic invocation** on the s41-shaped
  diffs: a correct getter → `clean`; a real load-order/dead-code bug → `broken`. Unit tests
  alone cannot prove a prompt change (self-authored fixtures do not exercise the model) — same
  class as `[chat/launch-marker-needs-prompt-contract]` / `[gate/agent-ci-ndjson-keyed-by-event-not-type]`.
- Follow-on (separate, s42 priority #2): `[rework/reply-b-drops-critic-feedback]` — the
  reply-B rework loop must actually carry the critic's objection to the re-run. Tracked in its
  own spec.

## Related

- `003-roles-are-a-configurable-vendor-matrix.md` — the R1 mechanical-enforcement boundary this
  refines.
- `004-live-orchestrator-presence-and-post-review-autonomy.md` — the "never merge bullshit is
  only honest because the gate stays mechanical" thesis this leans on.
- `docs/gotchas/critic-before-ci-blocks-testless-repos.md` — the s41 blindspot this resolves.
- `docs/superpowers/specs/2026-07-15-critic-correctness-gate-design.md` — the implementation spec.
- `docs/VISION.md` — mission anchor.
