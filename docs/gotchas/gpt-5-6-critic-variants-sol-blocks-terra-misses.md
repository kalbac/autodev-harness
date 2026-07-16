# `[critic/gpt-5.6-variant-behaviors]` — the three gpt-5.6 critic variants have distinct, stable failure modes; don't blind-swap

**Found:** s44 (2026-07-16), calibrating gpt-5.6 as the critic gate model.

## What

The codex CLI (0.144.4) exposes three gpt-5.6 variants — **Sol / Terra / Luna** — and the CLI
**default is `gpt-5.6-sol`**. On our correctness-gate calibration (4 known cases × 3 rounds, the
exact production critic invocation + real `buildCriticPrompt`, effort `high`) each variant showed a
**stable, distinct** profile:

- **`gpt-5.6-sol`** — deterministically **false-blocks a correct change** (the committed method-id
  fix → `broken` 3/3, conf 0.91–0.97). Catches real bugs, but as a gate it wedges good, already-shipped
  work. Also the **most expensive** variant (positioned as a Fable-5 competitor). **Worst gate profile.**
- **`gpt-5.6-terra`** — clean cases perfect, but **unreliable on catching a real bug** (the method-id
  parse bug: 1× clean-MISS, 1× uncertain, only 1× decisively broken over 3 rounds). Cheap, but "lets a
  real bug through ~1-in-3" = the exact "merge bullshit" the gate exists to stop. **Unsafe.**
- **`gpt-5.6-luna`** — **12/12 correct**, matches the trusted `gpt-5.5` baseline exactly with sharper
  confidence on the real bugs; **cheapest** of the family. **Promoted to the critic default (s44).**

## Why it matters

1. The CLI default (sol) is the WORST of the three for our gate — an **un-pinned** `roles.critic.model`
   silently drifts onto it (the s43 drift). **Always pin the model explicitly** (`schema.ts` default is
   now `gpt-5.6-luna`; every project config should pin too).
2. "Newer / more expensive model" ≠ "better critic." Sol is the priciest and the worst gate here;
   luna is the cheapest and the best. Calibrate, never assume.
3. A single run is not enough — sol/terra each have a failure mode that only shows as a *rate* over
   multiple rounds (terra's miss is 1-in-3). Run ≥3 rounds on the discriminating cases.

## Fix / rule

Before promoting ANY critic model, run `docs/wiki/critic-model-calibration-s44.md`'s set (validate the
fixtures reproduce the 5.5 baseline first — a fixture confound reads as a model defect, e.g. the
case-3 text-domain smell caught in the s44 smoke). Promote only a variant that catches the real bugs
AND does not false-block correct clean changes, across multiple rounds. Pin it explicitly everywhere.

## Related
- `docs/wiki/critic-model-calibration-s44.md` — full methodology + results.
- `docs/adr/005-critic-is-a-correctness-gate-coverage-is-mechanical.md` — the clean/broken semantics.
- `[gate/critic-before-ci-blocks-testless-repos]`, `[orchestrator/llm-retitle-breaks-task-level-dedup]`
  — same lesson class: never trust an LLM-facing behavior on a single self-authored run.
