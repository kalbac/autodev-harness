# Critic model calibration — gpt-5.6 (Sol / Terra / Luna) vs gpt-5.5 (s44)

> Reusable methodology + the s44 result. Re-run this before promoting ANY new
> critic model. The critic gates every merge — a wrong model either lets bugs
> through ("merge bullshit") or blocks correct work (wedges good tasks).

## Why

End of s43 the operator upgraded the codex CLI (0.144.4); `gpt-5.6-sol/terra/luna`
became invokable. The gate had been drifting onto the CLI default (`gpt-5.6-sol`)
when un-pinned. FUTURE-BACKLOG asked to calibrate a 5.6 variant vs the trusted
`gpt-5.5` on the known cases before promoting one.

## Method (faithful to production)

The critic verdict depends only on the model + the exact prompt + the schema. The
calibration replays the **real production invocation** with only `-m` varied:

```
codex exec -m <MODEL> -c model_reasoning_effort="high" -c approval_policy="never" \
  -s read-only -C <repoRoot> --skip-git-repo-check \
  --output-schema dist/critic/critic-verdict.schema.json -o <outfile> -
```

- Prompt built with the **real** `buildCriticPrompt(diff)` from `dist/` (byte-identical
  to the gate) — see `scratchpad/build-prompts.mjs`.
- Effort `high` (the production default), `read-only` sandbox, verdict parsed from the
  `-o` outfile exactly like `CodexCriticAdapter`.
- Runner: `scratchpad/run-model.sh <model> <round>`.

## The 4 known cases (the calibration set)

Reconstructed faithfully in the `woodev-shipping-plugin-test` plugin style, then
**validated against the gpt-5.5 baseline** — if 5.5 reproduces the historical
verdicts, the fixtures are faithful and the 5.6 comparison is apples-to-apples.

| # | Case | Expected | Historical 5.5 | Source |
|---|------|----------|----------------|--------|
| 1 | method-id parse **bug** — compares full `method_id:instance_id` rate id against the bare method id (no `explode(':')`) → silently never matches | non-clean | broken 0.72 (s43) | reverse of `af8d856` |
| 2 | method-id **fix** — `explode(':')` + prefix compare (the committed correct fix) | clean | clean 0.79 (s43) | `af8d856` / saved `diff.patch` |
| 3 | correct **getter** — a trivial, correct new public static accessor, no test | clean | clean 0.82 (ADR-005) | s41-shaped |
| 4 | **load-order** silent-skip — `add_filter` registered at load time under a load-time `class_exists('WooCommerce')` guard that can silently skip | broken | broken 0.76 (s42) | s41 WC_Integration bug |

**Baseline validation (gpt-5.5, high):** case1 broken 0.8 · case2 clean 0.82 · case3
clean 0.78 · case4 broken 0.84 — **4/4 matches the historical directions**, confidences
within ~0.06 of history. Fixtures are faithful.

> Fixture gotcha: the first case-3 draft returned a translatable string copied from
> the constructor (`__('...','woocommerce-dhl-express')`); sol correctly flagged the
> text-domain mismatch → `broken 0.98`. A "correct getter" must be unimpeachable — the
> final case-3 returns a bare non-translated constant. A confound in a calibration
> fixture reads as a model defect. (Smoke caught it before the real runs.)

## Result — 3 rounds each (12 judgments per model)

| Case | Expect | gpt-5.5 | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna |
|------|--------|---------|-------------|---------------|--------------|
| 1 method-id bug | non-clean | broken 0.80 | broken/broken/uncertain ✓ | **clean 0.78** / broken / uncertain | broken 0.90/0.91/0.93 ✓ |
| 2 method-id fix | clean | clean 0.82 | **broken 0.91/0.94/0.97** ✗✗✗ | clean 0.78/0.88/0.87 ✓ | clean 0.84/0.86/0.84 ✓ |
| 3 getter | clean | clean 0.78 | clean ✓ | clean ✓ | clean 0.94/0.84/0.78 ✓ |
| 4 load-order bug | broken | broken 0.84 | broken 0.98/0.97/0.98 ✓ | broken 0.88/0.91/0.94 ✓ | broken 0.95/0.98/0.96 ✓ |

All runs exit 0, verdict parsed from the outfile. Latency ~25–80s/call.

## Decision — promote **gpt-5.6-luna**

- **luna — 12/12 correct, all 3 rounds 4/4.** Matches the trusted 5.5 baseline exactly,
  with **sharper confidence on the real bugs** (0.9+ vs 5.5's 0.80/0.84). It is the
  **cheapest** of the family (positioned as the everyday model). Rare win-win: cheaper
  AND at least as accurate. **This is our critic now.**
- **sol — rejected.** Deterministically **false-blocks the correct method-id fix**
  (case2 → broken 3/3). For a gate this wedges good, already-shipped work. Also the
  **most expensive** variant (positioned as a Fable-5 competitor). Worst gate profile here.
- **terra — rejected.** Clean cases are perfect, but it is **unreliable on catching the
  real method-id bug** (case1: 1× clean-MISS, 1× uncertain, only 1× decisively broken).
  A gate that lets a real bug through ~1-in-3 is exactly "merge bullshit." Cheap, but unsafe.

## What was applied (s44)

- `src/config/schema.ts` — critic model default `gpt-5.5` → `gpt-5.6-luna` (prevents the
  s43 un-pinned drift onto sol; the vetted model is now the fallback everywhere).
- `src/detect/detect-agents.ts` — codex model catalog now offers the three 5.6 variants
  (luna/terra/sol) + the 5.5 pair, so the role-matrix UI picker can select them.
- `woodev-shipping-plugin-test/.autodev/config.yaml` — critic pinned explicitly to
  `gpt-5.6-luna` / effort `high` (what the s44 poison-fix live-prove runs on).

## Caveats / follow-ups

- Evidence is **n=3 on one project's PHP/WooCommerce diff shapes.** Strong signal
  (luna 12/12, sol/terra each with a stable failure mode), but domain-limited. Re-run
  this set (and add cases) if a future project's language/shape differs materially.
- `gpt-5.5` still works on CLI 0.144.4 (baseline ran clean) — the bump is a forward move,
  not a forced migration.

## Related
- `docs/adr/005-critic-is-a-correctness-gate-coverage-is-mechanical.md` — case 2/3 semantics.
- `docs/gotchas/reply-b-poisons-maxrounds-exhausted-task.md` — the s44 (a) fix that live-proves on luna.
- `docs/FUTURE-BACKLOG.md` — the eval item this closes.
