# Spec — Narrow the critic to a correctness gate (coverage is the machine gate's job)

**Date:** 2026-07-15 (s42)
**Doctrine:** `docs/adr/005-critic-is-a-correctness-gate-coverage-is-mechanical.md`
**Resolves:** `[gate/critic-before-ci-blocks-testless-repos]` (s41 finding 2)
**Operator review:** waived (overnight autonomy grant, s42) — the design was presented with an
explicit veto checkpoint and not vetoed.

## Problem (one paragraph)

The independent critic HARD-fails any behavioral change that lacks a new guard/test. agent-ci
CI runs only *after* a `clean` verdict. So in a repo with no reachable test harness, no feature
task ever reaches CI — only behavior-neutral changes pass. Proven live s41 (a correct getter
was blocked `broken 0.73` for "missing coverage"; only a docblock reached the green CI DONE).

## Decision (from ADR-005)

The critic judges **correctness + fabrication**, not **coverage**. Coverage enforcement is the
deterministic machine gate's job (declared contract zones + mutation-verified, blessed guards)
plus agent-ci against the repo's existing tests. A correct change that merely lacks a brand-new
test is `clean`, not `broken`. A test edited to match a changed value is still fabricated →
`broken`.

## Scope

**One production file:** `src/critic/prompt.ts`. **One test file:** `src/critic/prompt.test.ts`.
No changes to `conductor.ts`, `gate.ts`, the round loop, the step order, or config. This is a
prompt-only behavioral change; the mechanical enforcement floor is untouched.

## The prompt change (`buildCriticPrompt`)

Four edits, section by section:

1. **`## Default assumption`** — remove `a missing guard` from the clean-blocker enumeration.
   New text keeps the assume-broken framing but blocks only on a broken contract, a fabricated
   proof, or a logic/regression flaw:
   > "Only conclude `clean` if, after genuinely trying, you cannot find a broken contract, a
   > fabricated proof, or a logic/regression flaw. A correct change that merely lacks a
   > brand-new test is NOT a reason to withhold `clean` — coverage is enforced mechanically by
   > the gate, not by you (see below)."

2. **New section `## Coverage is not your job`** (inserted after Default assumption, before
   Fencing):
   > "Do NOT fail a diff because a correct behavioral change lacks a NEW test locking it. That
   > is a coverage gap, not a defect, and it is enforced *mechanically* by the machine gate
   > (declared contract zones + mutation-verified, operator-blessed guards) and by the repo's
   > existing CI — never by you. Judge whether THIS diff is CORRECT. If a behavioral touch is
   > uncovered, note it in `notes` as information for the operator — do NOT lower the verdict
   > for it. (A test EDITED to match a changed contract value is a different thing entirely: it
   > is a fabricated proof — see the checklist — and IS a `broken` verdict.)"

3. **`## Checklist`** — reframe item 2 from decisive to diagnostic; keep 1, 3, 4 intact:
   - 1. Which contract zones does this diff touch? *(unchanged — a useful signal)*
   - 2. *(reframed)* "For each touched zone, NOTE whether an existing test covers it — for the
     operator's information only. A MISSING new test is not, by itself, a `broken` verdict."
   - 3. Fabricated-proof detection *(unchanged — a test edited to match a changed value is
     `broken`)*.
   - 4. Logic / regression risk independent of contracts *(unchanged)*.

4. **Output format** — unchanged (verdict schema).

The NO-TOOLS preamble and Fencing sections are unchanged.

## Test contract (`prompt.test.ts`)

Keep every existing assertion that still holds (inline diff, NO-TOOLS preamble, assume-broken,
fencing, JSON schema fields). Update the checklist test and add coverage-doctrine assertions:

- **Retain:** inline-diff embed; NO-TOOLS preamble; `assume ... breaks a contract`; do-not-read
  worker-report + commit-message; JSON object with `verdict`/`broken_contracts`/`notes`/
  `confidence`.
- **Change:** the "all four checklist concerns" test — it currently asserts `/guard.*test/i` as
  a decisive concern. Keep asserting the prompt still *mentions* contract zones, fabrication,
  and logic/regression, but drop the implication that a missing guard is decisive.
- **Add:** `it("does not treat a missing new test as a clean-blocker")` — assert the prompt
  does NOT list "missing guard" among the clean-blockers, and DOES contain the coverage-is-
  mechanical statement (e.g. matches `/coverage is enforced/i` and `/lacks a (brand-new|new) test/i`).
- **Add:** `it("still treats a fabricated proof as broken")` — assert the fabricated-proof
  language survives (`/fabricated.proof/i` + `/broken/i`).

## Verification (end-to-end — mandatory, prompt changes are not proven by unit tests)

A prompt change's real behavior is only proven by invoking the real critic. Two real
`codex exec` critic runs on s41-shaped inline diffs (the same adapter the conductor uses):

1. **Correct getter diff** (a new correct public method, no new test) → expect `verdict:
   "clean"`. This is the s41 attempt-3 case the old prompt failed `broken 0.73`.
2. **Real load-order / dead-code bug diff** (an `add_filter` under a load-time `class_exists`,
   or an obviously-wrong change) → expect `verdict: "broken"`. Confirms the gate stays real.

Both diffs are PHP (matching the s41 project), fed through `buildCriticPrompt` → the real
codex adapter. Record the verdicts as the end-to-end proof. Also run the full `npm test` +
`npm run typecheck` (root) green.

## codex GPT-5.5 gate

The change touches the critic's core behavior — mandatory codex review of the diff before
merge, re-critic any in-place fixes. Declines allowed with rationale verified against the real
code.

## Out of scope (explicitly)

- No reordering of CI vs critic (ADR-005 rejects it).
- No repo-capability / harness detection wiring (the blunt "coverage is the gate's job"
  statement is sufficient and simpler; no need to detect harness presence).
- No `conductor.ts` / `gate.ts` change.
- The reply-B rework fix (`[rework/reply-b-drops-critic-feedback]`) is a separate s42 priority
  with its own spec.

## Related

- `docs/adr/005-critic-is-a-correctness-gate-coverage-is-mechanical.md`
- `docs/gotchas/critic-before-ci-blocks-testless-repos.md`
- `src/critic/prompt.ts`, `src/critic/prompt.test.ts`, `src/critic/codex-adapter.ts`
