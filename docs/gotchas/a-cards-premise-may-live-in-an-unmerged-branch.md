# `[orchestrator/premise-in-an-unmerged-branch]` — the card describes code the baseline does not have

**Tag:** `[orchestrator/premise-in-an-unmerged-branch]`
**Found:** s64, live run on `woodev-base-theme` (#160, #161).

## What happened

The operator picked his own card `woodev-base-theme#52` for a live run: *introduce a
carve-out so the three WooCommerce template overrides under `woocommerce/myaccount/` may keep
the `woocommerce` text domain*. The composer decomposed it into three tasks and the drain ran.

**None of those three files existed in the harness's baseline.** They lived only on the
operator's open PR #50 (`feat/cart-checkout-account`), two commits ahead of `main`, and the
harness's clone tracks `main`.

Nothing refused. `validateTaskSpec` checks the SHAPE of `file_set` and its overlap with
`forbidden_paths`; it never asks whether the paths exist (and cannot simply require it — a
task may legitimately create files).

## Why it was expensive rather than merely empty

The task that named the missing files would just have done nothing. The damage came from its
sibling, which *did* run: the carve-out in `I18nSourceTest`. Written as a **path rule** ("any
i18n call under `woocommerce/`"), it delivered none of the card's value — the target files
were absent — while opening the `woocommerce` domain for the files that WERE there
(`content-product.php`, `single-product/meta.php`) and their five theme-authored strings.
Zero benefit, real weakening.

The critic caught it (`broken` @0.98) and the gate held. But it named the **symptom** ("the
carve-out is broader than the stated exception"), not the **cause** ("this task is about a
tree that is not here") — so from the escalation alone the operator could not see why.

Two rounds later, after a reply-B rework, the worker had extracted constants, extracted a
helper, written documentation and **added a test** — while the rule stayed behaviourally
identical. The critic's second verdict is the sharpest sentence of the session: the new test
*"encodes the weakened contract rather than the stated copied-core-only exception."*

## Rules

- **Before decomposing a card, check the baseline actually contains what the card talks
  about.** A card is written against the author's mental repo state, which may be a branch,
  a draft PR, or a plan. Grep for one named symbol or path from the card first; it costs
  seconds.
- A `type: fix` whose `file_set` names paths that do not exist is a **broken postulate**, not
  a worker problem. Escalating it as `blocked` costs one message; running it costs worker
  rounds, critic rounds, and an escalation whose stated reason is wrong.
- **Check that the acceptance criterion is mechanically decidable in this project.** #52's
  real condition — "the string is copied verbatim from WooCommerce core" — cannot be checked
  by a unit suite that never loads WooCommerce. A worker facing an undecidable requirement
  has no way to say so, so it produces something that *looks* like compliance. Prefer an
  enumerable form (an explicit list of the exact strings) over a predicate nothing can
  evaluate.
- Same family as `[orchestrator/invented-success-command]`: an LLM emitting a plausible
  reference to something the project does not contain, with no validator asking.

## Related

- `docs/gotchas/composer-invented-a-command-the-project-does-not-have.md` — the command
  version of the same shape.
- `docs/gotchas/critic-sees-only-the-diff-hunk.md` — why the critic saw the symptom.
- Issues #160 (no existence check), #161 (worker answers a correctness objection with a
  refactor), #162 (escalation offers only A/B — no park, no abandon).
