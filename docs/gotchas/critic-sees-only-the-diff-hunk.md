# The critic's evidence window is the diff hunk — a clean verdict is unreachable for anything referencing context outside it

**Tag:** `[critic/diff-hunk-only-evidence]` · Found s56 (first live Evaluation Corpus run)

## What happens

`src/critic/prompt.ts` builds the critic prompt from `diff.patch` — the change and its
three lines of standard context, nothing else. The critic reasons fail-closed, which is
correct in isolation: *if I cannot verify it from what I was given, it is not clean.*
Combined, those two facts make a **clean verdict structurally unreachable for any change
whose correctness depends on code outside the changed lines** — which is most real work.

Measured, not inferred. First live corpus run, 4 good cases, **0 committed**
(`first_pass_commit_rate: 0%`), verbatim from the escalations:

- Replacing a hard-coded `array( 1, 2 )` with `self::SUPPORTED_ZONE_IDS` — the constant is
  declared **15 lines above, in the same file** → `uncertain`:
  > *"The changed implementation is correct only if `SUPPORTED_ZONE_IDS` is an existing
  > class constant containing the intended zone IDs. That declaration and value are not
  > present in the inline diff, so the replacement cannot be independently verified."*
- A **documentation-only** append → `uncertain`:
  > *"The factual claims ... cannot be independently verified from the inline diff alone,
  > so a clean verdict is not provable."*

## Why it went unnoticed for five sessions

Every live proof that reached a commit before s56 — `44bb027`, `35db1a4`, `fb21553`,
`c0fb8de` — was **additive and self-contained**: a new method returning literals, a new
file, a docblock. Their correctness is visible entirely inside the hunk, so the critic
could clear them. Nothing that referenced pre-existing context had ever been driven to a
commit. The harness was not "working and occasionally strict" — it had only ever been
exercised on the one shape of change this limitation does not touch.

**The transferable lesson:** a set of green live proofs characterizes the harness only over
the shapes of work those proofs contain. Four green additive proofs said nothing about
edits, and reading them as "the loop works" was the error. That is precisely what an
evaluation corpus is for, and it is why the corpus's very first run was worth its cost —
it found this in 11 minutes after five sessions of green proofs missed it.

## Related, non-obvious

- The window is narrow **because of** the Windows workaround: codex cannot read files from
  its sandbox (`[critic/codex]` → embed the diff inline), so the inline diff became both
  the transport and the evidence budget.
- A second failure mode hides behind the same symptom and must not be conflated with it: a
  good case can also die as `poison` → `quarantine` when the worker exhausts its attempt
  budget against a profile gate (`attempts=4 > maxAttempts=3`). One reports as `escalated`,
  the other as `quarantined`; the Corpus Report alone cannot distinguish *why* (issue #126).
- Fixing this is a **measurable** change: re-run the corpus and compare
  `first_pass_commit_rate` before/after. Candidate directions, cheapest first: widen the
  diff context (`-U50`), attach the full before/after text of each changed file, or give
  the critic file access (blocked on Windows). Tracked in issue #123.

## Related

- `docs/gotchas/codex-exec-windows-sandbox-review-inline-diff.md` — why the diff is inline.
- `docs/gotchas/critic-before-ci-blocks-testless-repos.md` — the *previous* time the critic
  blocked correct work for a structural reason (`adr/005` narrowed it to correctness).
- `docs/gotchas/prove-the-product-goal.md` equivalent in memory: `[[feedback-prove-the-product-goal]]`
  — "no crash" is not proof of the product goal, and neither is a green proof of the one
  easy shape.
- `docs/PRINCIPLES.md` #13 (evidence, not assertion), #15 (the gate proves only formalized
  properties).
