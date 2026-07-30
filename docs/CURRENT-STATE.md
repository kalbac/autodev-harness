# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s65)

**A real CI has gated the harness's work in the operator's repository, for the first time.**
`#157` is discharged, and the detail is the point: **pushing the branch would not have done
it.** His `ci.yml` triggers on `push: branches: [main]` and on `pull_request`, so
`autodev/main` landing on origin produces exactly the empty CI surface he complained about.
What produces evidence is the PR — `kalbac/woodev-base-theme#55`, **CI 4/4 green**:

| job | result |
|---|---|
| `php-qa` (phpcs + phpstan + unit, PHP 8.1 floor) | pass, 30s |
| `js-qa` (lint, format, tokens:check, test:js, build) | pass, 27s |
| `php-integration` (wp-env container suite) | pass, 1m22s |
| `e2e` (wp-env + Playwright) | pass, 4m48s |

Two of those — the integration suite and e2e — the harness does not run at all, so this is
the first time the work was judged by checks outside the gate's own reach.

**`#52` is answered, implemented and committed** (`f34595a`), as an EXPLICIT ALLOWLIST of 12
msgids rather than the path rule that failed twice in s64. The criterion is the operator's
own, and it is sharper than the one the card started with: a string may name `woocommerce`
only when core ships **that exact msgid** under that domain, because a near miss never
resolves AND drops out of the theme's own POT — worse than leaving it alone. Measured against
a real WooCommerce checkout: `SKU` is `SKU:` in core, `Action` is `Actions`, `Category`/`Tags`
are `Category:`/`Categories:` and `Tag:`/`Tags:`. Those four stay on the theme domain; 19 call
sites across five override files switched, covering exactly the 12.

**His own ruleset forbade his own decision, and that is the run's real finding.**
`phpcs.xml.dist` declared `text_domain` as a one-element list, so every carve-out call was
`WordPress.WP.I18n.TextDomainMismatch` — the task was **unsatisfiable until the ruleset
changed**. The worker could not fix it and must not be able to: the file is declared in
`contract.gateRulesets` and sits inside the `adr/006` fence. So the resolution was an operator
act — he blessed it, and it was applied OUTSIDE the worker's diff (`29b6ae4`), which is
Principle 14 in its intended shape rather than as a refusal.

**The narrow fix was wrong, and only running it said so** (gotcha 98). A second
`<rule ref="WordPress.WP.I18n">` with an `<include-pattern>` for the subtree was presented to
the operator as "the technically correct form" and then measured before shipping:
`include-pattern` scopes the **sniff**, not the property, so outside the subtree a foreign
domain and a missing `$domain` argument both stopped being reported at all. It reads as a
tightening and behaves as switching i18n checking off for the rest of the theme, with
`composer phpcs` exit 0 and no alarm. Shipped instead: the property widened globally, the
SCOPE and the msgid list living in `I18nSourceTest`, which runs in the same gate — the
effective rule is the intersection of the two layers, which neither states alone.

**Verified independently, not taken from the verdict.** `composer test:unit` 510 tests (was
509) / 1672 assertions, `composer phpcs` exit 0 tree-wide over 119 files, `composer phpstan`
`[OK] No errors`. The guard is mutation-verified in three directions, each probe disabling
exactly one mechanism: a non-allowlisted msgid inside the subtree fails; an allowlisted msgid
outside it fails; and `_x`'s context altered by one article (`hash before the order number`)
fails. Tree clean after every probe.

**The composer's split WAS the earlier failure.** s64 decomposed this into three tasks with
`depends_on`, which is why "change the test" existed on its own as a pure weakening and was
correctly killed by the critic. Told in the intent to keep it one change, the composer emitted
**one task over all seven files**, and decomposition took 49s instead of seven minutes.

**s64's one commit to his repo was a false claim, and it is now true.** `11b9592` wrote into
his `AGENTS.md` that the carve-out covers "i18n calls reproducing WooCommerce core's own copy
verbatim" and that this is "enforced by `tests/php/Unit/I18nSourceTest.php`". Both halves were
false: the criterion is undecidable in a suite that never loads WooCommerce, and the test
enforced the opposite. Corrected in the same commit as the implementation.

Also cleared this session: a wedged `run --drain` from s64 (alive 2h over an empty queue) and
a daemon running a `dist` older than the s64 `#155` fix. New: **#163** (`agent_ci_green: true`
when agent-ci is DISABLED — "nothing to run" serialized as "passed", the field that made s63's
CI wording possible), **#164** (escalation artifacts never cleaned when a task terminalizes;
not a second truth — `state` reads the queue and returns `escalated: []`), gotcha 98.

## Where we were (leaving s64)

**The ruler the harness judges his code by was wrong, and the harness found it on his repo.**
`adr/010` (s63) let a project declare its own phpcs ruleset; the same run produced #155. A
project-declared ruleset is read from the TRUSTED ROOT, and PHPCS resolves a relative
`basepath` against the RULESET FILE's directory — so his `phpcs.xml.dist` makes every finding
arrive relative to the repo root while the gate runs with the worktree as cwd. Measured, both
directions, one file:

| ruleset | reported path |
|---|---|
| the profile's (no `basepath`) | `D:\...\worktrees\s64-probe\...` — absolute |
| his `phpcs.xml.dist` (`basepath="."`) | `.autodev\worktrees\s64-probe\...` — relative to the trusted root |

Every finding therefore landed `unattributed` — kept (fail-closed) but judged over the WHOLE
FILE, which is the guarantee `profile-gates-must-be-diff-scoped` exists to give, suspended by
`adr/010`'s own mechanism. Harmless on his clean theme; unsatisfiable on a legacy file. Fixed,
pinned on a verbatim capture.

**Six review rounds, and the count is the point.** R1 minor · R2 major · R3 three (two
fail-OPEN) · R4 four (two fail-OPEN, one of them older than #155: a ROOTED report path never
reached the canonicalizer, so `src/./a.php` matched no diff key and a violation on an added
line was silently DROPPED) · R5's blocker **disproved by running its exact input** and declined
with the measurement · R6 pending at session end. R4 also caught the shape now recorded as
gotcha 96: the incomplete-UNC refusal had been moved AFTER the canonicalizer that erases the
shape it refuses, so it stopped firing while its test kept passing for an unrelated reason.

**#153 is answered and shipped**: four contract zones on his theme (text domain, hook prefix,
`--wtb-`, FilterRail query vars), each verified through the harness's own parser to fire on a
declaration change and NOT on ordinary use. Short arrays deliberately not a zone — already
refused outright by phpcs and fenced by `adr/006`.

**No CI has ever run on the harness's work in his repo (#157).** He noticed the empty CI
surface and was right: the clone's `autodev/main` has never been pushed, and `agentCi` is off.
s63's wording here has been corrected — see below.

**Live run, and the thing it actually found.** 3 tasks on the theme; `11b9592` committed with
`zones_touched: []` on a docs change. The other two were about `woodev-base-theme#52`, and
**their premise was not in the baseline**: the three `woocommerce/myaccount/` files the card is
about lived only on his open PR #50. So the carve-out task delivered none of the card's value
while opening the `woocommerce` domain for the two files that WERE there and their five
theme-authored strings. The critic returned `broken` @0.98; the operator answered **B**; the
rework extracted constants, wrote docs and **added a test** while leaving the rule behaviourally
identical — `broken` @0.97, with the sharpest sentence of the session: the new test *"encodes the
weakened contract rather than the stated copied-core-only exception."* Both tasks were parked in
`quarantine` by hand, because A would commit the weakening and B only loops (#162). **The gate
held: the weakening never reached a commit.** New: #160, #161, #162, gotcha 97.

Neither committed task produced a phpcs finding, so the run gives **no live attribution
evidence** — #155's proof is the capture plus gate-level tests, and that limit is stated rather
than papered over.

**Post-session state:** his PR #50 is merged, the clone is synced (`99f558c`, a merge of
`origin/main` into `autodev/main` — not a reset), the three files now exist, and his suite is
green there (**509 tests, 1 skipped**). #52 is ready to re-queue in a REFORMULATED shape.

## Where we were (leaving s63)

**The harness did real work in the operator's own repository, and it committed.**
`woodev-base-theme` — his active WordPress theme, not the polygon — through a clone the
harness owns. His issue #46, chosen by him: `FilterRail::reset_url()` removed the
`sanitize_key()`'d query var name instead of the original, so the Reset link silently kept
any filter whose key was not already a lowercase slug.

| | evidence |
|---|---|
| Commit | `6908cb6` on `autodev/main`, 2 files, +31/−10 |
| Critic | `clean` @0.96 (round 1), `clean` @0.94 (round 2) — on a REFACTOR, not an addition |
| Gate round 1 | **RETRY** — phpcs red on one real defect the worker made (a docblock opening lowercase, `Generic.Commenting.DocComment.ShortNotCapital`) |
| Gate round 2 | green → commit |
| His `composer test:unit` | **397** tests (was 396), 1256 assertions, green |
| His `composer phpcs` | whole theme, exit 0 |
| His `composer phpstan` | **[OK] No errors** — a gate the harness never ran |
| Guard is real | reintroducing the bug fails **2** tests (mutation-verified, restore clean) |

Three of the four PHP checks his CI runs pass, including one the harness does not run — but
**they were run LOCALLY at the commit, and no CI ran at all** (corrected s64, on the
operator's observation that his dashboard showed no CI). The clone's `autodev/main` was
never pushed, so his GitHub Actions never saw the work, and `gate.agentCi.enabled: false`
means the harness ran none either. The local runs are real evidence about the code; they are
not evidence that a CI gate passed, and the earlier wording here ("his four PHP CI checks
pass") invited exactly that reading. Tracked as **#157**.

The loop itself behaved exactly as designed: the gate refused work carrying a genuine defect,
named it by file/line/sniff, and the worker fixed that and only that.

**It could not have run at all before `adr/010`.** Measured on the same diff: under the
profile's own ruleset it draws **8** violations, 6 of them `DisallowShortArraySyntax` — the
theme *mandates* short arrays and forbids long ones, so the two standards are mutually
exclusive on the same predicate and no line containing an array literal could satisfy both.
A project may now DECLARE the ruleset its gate is judged by (`contract.gateRulesets`), read
from the trusted root, with the declared file joining the `adr/006` fence. Under his own
ruleset the same diff draws **1** violation — the real one above. The gate went from
*unsatisfiable* to *demanding and correct*.

**The review gate earned its keep, twice.** R1 returned NOT SAFE on four findings: one
declined on facts, one already found live, and **two real oracle-fence escapes** — a ruleset
named `rules[1].xml` was a literal to the gate and a *pattern* to the fence (so the worker
could rewrite the standard it is judged by without escalating), and a declaration on a
profile-less project skipped every fail-closed rule while still joining the protected set.
R2 on the fixes: SAFE.

**The run's own finding, and it is the honest deliverable (#155).** A project-declared
ruleset with `basepath=.` anchors phpcs report paths at the TRUSTED ROOT, while the gate runs
with the worktree as cwd — so findings arrive as
`.autodev\worktrees\<task>\tests\…` and are marked `unattributed`. They are kept
(fail-closed, correct) but **line-scoping does not apply to them**. It did not bite here only
because the theme is clean; on a legacy file the worker would inherit the whole file's debt —
gotcha 82's defect, through a door `adr/010` itself opened. A `[critic/validated-one-string-used-another]`
instance created by the fix for #152.

Also reproduced on a real repo: **#148** (`success_commands: []` on every task), and
`composer_green: true` is still byte-identical for "the check passed" and "there was no
check".

Open for the operator: **#153** — which of the theme's values deserve contract zones. Zones
were left deliberately empty, because a zone is an oracle and the oracle is his; ones the
agent invented would have measured the agent's guesses.

## Phase status

| Area | Status |
|---|---|
| Core loop (P1, headless) | ✅ shipped, parity-proven against the PS oracle |
| Web dashboard (P2) | ✅ product-track items 1–4 done; general polish ongoing |
| Attended live-orchestrator presence (`adr/004`) | ✅ shipped (s40, PR #72) |
| Unattended autonomy (`adr/004`) | ✅ COMPLETE — all four slices |
| Critic model | ✅ codex `gpt-5.6-luna` (calibrated s44; **pin it**) |
| Authority Model (`adr/006`) | ✅ Phase 1 + 2 + 3 shipped |
| Profiles / Qualification Layer | ✅ v1 (s51). **v3 s63 (`adr/010`)**: a project may DECLARE the ruleset its gate is judged by, read from the trusted root and fenced as oracle — without it the harness could not write a passing line of PHP in the operator's own theme |
| Reporting (Execution + Qualification + Morning) | ✅ shipped s52–s53 |
| Evaluation Corpus | ✅ machinery + `eval` CLI + **8 cases**; run SIX times. s61 met the bar 7/7; **s62 deliberately broke the ceiling: 8/9, first-pass commit 83.3%, escaped 0%, 0 errored** — the corpus can fail again and does (#147). One case deleted the same run for passing vacuously (#148/#149) |
| **The harness on a REAL operator repo** | ✅ **s63** first commit (`6908cb6`) · ✅ **s64** second (`11b9592`) · ✅ **s65 — THIRD commit (`f34595a`) AND THE FIRST REAL CI GATE**: `autodev/main` pushed, PR `woodev-base-theme#55` open, **CI 4/4 green** incl. two suites the harness never runs. **#157 CLOSED.** The mechanism matters: a branch push alone triggers nothing (`on: push: branches: [main]`) — the PR is what gates it |
| **Declared rulesets (`adr/010`) meet a real oracle conflict** | ✅ **s65** — his own `phpcs.xml.dist` FORBADE his own product decision (#52), so the task was unsatisfiable until the ruleset changed; the worker cannot change it (`adr/006` fence), so the operator blessed it and it was applied OUTSIDE the worker's diff (`29b6ae4`). The narrow path-scoped shape was measured and rejected — `include-pattern` scopes the SNIFF (gotcha 98) |
| **Contract zones on his theme (#153)** | ✅ **s64 — four zones declared from HIS choice**, each verified through the harness's own parser to fire on a declaration change and not on ordinary use. `GUARDS.md` deliberately still empty: blessing a guard is his act, so a touched zone escalates by name and value |
| **Project legibility (#138)** | 🟡 first slice shipped s62 — `GET /projects/:id/guarantees` + the "What this project guarantees" screen, live-verified. Umbrella still open: corpus metrics in the UI, per-field explanations (#96) |
| **Task-command authority (`adr/009`)** | ✅ **MERGED + MEASURED** (PR #145) — the composer may only reference declared commands; the gate refuses to RUN one that does not exist |
| Corpus run diagnostics (#126) | ✅ shipped s57 — and it is what identified #143 from archived artifacts without a re-run |
| Critic evidence window (#123) | ✅ FIXED + MEASURED (PR #134) — 0% → 50% first-pass commit |
| Critic mandate (`adr/007`) | ✅ MERGED (PR #139) — leniency scoped by an operator-declared `contract.docPaths` |
| **Contract-zone scope (`adr/008`)** | ✅ **MERGED + MEASURED** (PR #142, CI 4/4, 9 rounds). The targeted case now commits; the aggregate did not move because the instrument lost a different case |
| Critic availability | ✅ working. Residual: ONE provider is both the review gate and the harness's own critic (#129) |

> Per-feature shipping history belongs in `SESSION-LOG.md`, not here.

## The thrust — SHIPPED, and the loop has now closed once

```text
Authority Model → Profiles → two reports → Evaluation Corpus → fix what it measures
```

s58 was the first turn of *the corpus names a defect, the defect is fixed, the corpus is
re-run, and the two numbers go side by side*. s61 is the fourth, and the first where the
numbers arrive with nothing in the way: **the loop works and the ruler works.** The corpus's
job now changes from "prove it can measure" to "measure something harder".

## NEXT ACTIONS

> **The operator's own priority, stated s62 and recorded because it had been asked before:**
> this harness is FIRST a tool he uses on his own woodev WordPress/WooCommerce repos, SECOND a
> product for others. The polygon `woodev-shipping-plugin-test` is a stand-in he made
> convenient; a capability proven only there is not proven for him.
>
> **s63–s65 discharged the first three items: it ran on his own repo, committed three times,
> and is now gated by his own CI.** What follows is what those runs exposed, in the order it
> costs him.

1. **`woodev-base-theme#55` is open and green — it is HIS to merge.** The documented separation
   holds (`.autodev/config.yaml`: "he merges what this clone produces"), so the harness does not
   merge into his `main`. Nothing is blocked on the harness here; the branch stays pushed and
   future work continues on top of it.
2. **The clone's `autodev/main` now has an upstream, which changes the sync story.** s64's
   handoff could say "the clone tracks `main`"; it now also pushes. Two consequences nobody has
   worked through yet: what happens when he merges #55 (does the harness fast-forward, or does
   `autodev/main` keep diverging), and whether a task that fails the gate should still leave a
   pushed branch behind. Neither has bitten yet — decide before the next multi-task run rather
   than during one.
3. **A live case that actually exercises attribution.** s64 proved #155 at the gate level with
   a real capture, but neither committed task produced a phpcs finding, so the fix has no
   end-to-end observation yet. The theme is clean under its own standard (`phpcs` exit 0
   tree-wide), so the debt case cannot be staged there honestly — the polygon can, by
   declaring a ruleset for it.
4. **#163 — a vacuously-true gate field reads as a pass.** `agent_ci_green: true` when agent-ci
   is DISABLED, byte-identical to "CI passed"; this is the field s63's overclaimed CI wording was
   built on, so it has already misled a report once. Same family as #148's `success_green`. Cheap
   and it removes a whole class of honest-sounding lie: tri-state `passed`/`failed`/`not_run`,
   which the profile gates already model correctly with `status` + `skip_reason`.
5. **#160 / #161 / #162** — the three findings the s64 #52 run produced: no existence check on a
   `file_set`; the worker answers a CORRECTNESS objection with a refactor (the mirror of #147);
   and an escalation offers only A/B, with no "reject and park" and no "abandon". **#162 bit
   again in s65** — reply-B was the only way to restart a task after the ORACLE changed under it,
   which worked but is the wrong verb for "the world changed, try again".
6. **#147 — the critic blocks a correct change whose correctness lives outside the diff, and
   the worker cannot argue back.** Measured, not suspected. Options are in the issue; the one
   that changes the most is giving the critic the CALLERS of the symbols a diff touches, so
   "nothing calls this" becomes a presentable fact instead of a guess. Note the counter-evidence
   from real repo work: s63's three-file refactor and s65's seven-file change both returned
   `clean`, so the #147 shape is narrower than "refactors park".
7. **#148** — the composer never populates `success_commands`, so `adr/009`'s whole machinery
   is unexercised · **#149** — a corpus case can assert only an OUTCOME, so it can pass for
   the wrong reason (the enabler for re-adding the deleted case).
8. **#138 continues** — corpus metrics in the UI; per-field explanations (#96) · **#164**
   (escalation artifacts never cleaned when a task terminalizes).
9. **#125** (`critic_total` always `0`) · **#124** · **#129** (one provider is both the review
   gate and the harness's own critic) · **#133** · **#122**.
10. Remaining #146 shapes: a second adversarial case aimed at the CRITIC, and a genuinely
    ambiguous intent whose right outcome is an escalation.

`FUTURE-BACKLOG` is FROZEN; open items are GitHub issues on board #2.

## Open questions

- **How hard should the corpus be?** With 7/7 and four saturated metrics, the corpus can no
  longer distinguish a good harness from a very good one. Which failures it should be able to
  show is a product question, not a mechanical one — see NEXT ACTIONS #1 for the shapes worth
  adding.
- **Does a second critic need operator consent to take over?** (#129) A silent automatic
  fallback changes the acceptance bar without anyone saying so — but a fallback that waits for
  a human is not a fallback at 3am.
- **Which oracle questions are actually the operator's?** (`adr/009`) s61 put two of them to
  him with options — the decisive-record rule and the metric denominator — and he declined:
  *"Реши сам как правильней. Такие архитекурные развилки я не понимаю."* The standing rule is
  now narrower: an oracle question is his when he can answer it in PRODUCT terms (which cases
  belong in the corpus, what the pass bar is); one that can only be compared by reasoning
  about ranking functions and denominators is the agent's — decided, implemented, and written
  into an ADR where it stays reviewable.
- **Is the conductor allowed to be stricter than the gate?** `adr/008` says yes in one place:
  on a diff neither can parse, the conductor reports every zone while the gate keeps git's
  file list, so a malformed diff can escalate a task the gate would have cleared. Named and
  accepted (the direction is toward a human); equalizing it means plumbing the gate's git file
  list through the conductor's dependency surface.
- **PHPStan in a profile.** Deliberately not a v1 gate: useful WordPress analysis needs
  `szepeviktor/phpstan-wordpress`, whose `extension.neon` a profile-shipped config cannot
  portably reference. Measured: without it, a correct file draws 14 phantom findings.
- **The analyzer toolchain is project-controlled.** A profile's gates run `vendor/bin/phpcs`,
  and `vendor` comes from the project's own `composer.json`. Named residual, not closed —
  and `adr/010` deliberately does not widen it: a project may now declare the RULESET, never
  the `run` command, because substituting the command substitutes the tool, and a tool that
  always exits 0 is a gate that proves nothing. The binary was already substitutable; the
  ruleset declaration adds nothing to that hole.
- **How much of a green gate is now the project's own claim?** (`adr/010`) A declared ruleset
  can be weaker than the profile's — that is the mechanism, not a leak, since the operator's
  declaration IS the oracle (Principle 14). What it costs is that "qualified by
  `wordpress-woocommerce@3`" no longer means one fixed bar across projects. The dashboard now
  says which standard is in force and whose it is, which is the honest minimum; whether the
  Qualification Report should also state it is open.
- **Oracle protection for `success_command`/`checkCommand`** — they are commands, not declared
  paths, so Phase 2 protects them only via `constitutionPaths`. **Half-closed by `adr/009`**: a
  task may now only reference a command the project DECLARES, and the gate refuses to run one
  that does not exist. What is still open is the content of an operator-declared command —
  nothing constrains what `gate.checkCommand` may BE, and `adr/009` deliberately exempts a
  declared command from the availability check (his declaration is the oracle).
- **Should one declaration buy two exemptions?** `contract.docPaths` was introduced for the
  critic's mandate (`adr/007`); `adr/008` (b) reuses it to scope the machine gate. Shipped on
  the operator's decision, and named here because a field's blast radius growing after it was
  blessed is exactly the drift `adr/006` exists to prevent.

## Recent sessions (full detail → `SESSION-LOG.md`)

> One line each — pointers, not summaries. Detail belongs in `SESSION-LOG.md`.

- **s65** — **A REAL CI FINALLY GATED IT** (branch `docs/s65-real-repo-ci`; theme commits `29b6ae4` + `f34595a`; `woodev-base-theme#55` **CI 4/4 green**). #157 closed, and the mechanism is the lesson: his `ci.yml` fires on `push: branches: [main]` and `pull_request`, so pushing `autodev/main` triggers NOTHING — "just push it" would have rebuilt the same empty CI panel with a branch on origin making the work look verified. #52 shipped as an EXPLICIT ALLOWLIST of 12 msgids (`f34595a`), the criterion sharpened by the operator himself: a string may name `woocommerce` only when core ships that exact msgid, since a near miss never resolves AND leaves the theme's POT (`SKU` vs core's `SKU:`, `Action` vs `Actions`). **The run's real finding: his own `phpcs.xml.dist` forbade his own product decision** — `text_domain` was a one-element list, so the task was unsatisfiable until the ruleset changed, and the worker cannot change it (`adr/006` fence) → he blessed it, applied outside the worker's diff (`29b6ae4`). The narrow path-scoped fix was recommended and then **measured and withdrawn**: `<include-pattern>` scopes the SNIFF, so outside the subtree a foreign domain and a missing `$domain` stopped being reported at all (gotcha 98). Verified independently: 510 tests, phpcs exit 0 over 119 files, phpstan `[OK]`, guard mutation-verified three ways. Also: told to keep it one change, the composer emitted ONE task over seven files where s64 had split it into three `depends_on` tasks — and that split WAS s64's failure. New: #163, #164, gotcha 98. Closed: #157, #52.
- **s63** — **THE HARNESS DID REAL WORK IN THE OPERATOR'S OWN REPOSITORY AND COMMITTED** (branch `feat/s63-real-repo`; theme commit `6908cb6`). `adr/010`: a project may declare the ruleset its profile gate judges by — measured first, both directions, on his `woodev-base-theme`, where the profile's ruleset and the project's are MUTUALLY EXCLUSIVE on array syntax (his theme mandates `[]`, the profile mandates `array()`), so the gate was literally unsatisfiable there. Same diff: 8 violations under the profile's ruleset, 1 under his. Ran his own issue #46 (`FilterRail::reset_url()` removed the sanitized key, not the original) end to end: critic `clean` @0.96 → gate RETRY on a genuine docblock defect → worker fixed exactly that → `clean` @0.94 → commit. Verified independently at the commit: his 397-test suite green, his phpcs exit 0, his phpstan `[OK] No errors` (a gate the harness never ran), and the new guard mutation-verified (reintroducing the bug fails 2 tests). Review gate R1 NOT SAFE → **two real oracle-fence escapes** (a ruleset named `rules[1].xml` is a literal to the gate and a pattern to the fence; a declaration on a profile-less project skipped every fail-closed rule) → R2 SAFE. New: #153/#154/#155, gotcha 94 (`[test/mutation-check-noop]`) plus an amendment to `[ops/codex-quota-exit-zero]`, and a narrowing of the s21 vendor-junction gotcha that made a runtime phpunit gate possible at all.
- **s62** — **THE CORPUS CAN FAIL AGAIN, AND DID** (branch `feat/s62-corpus-harder`; corpus `RESULTS-2026-07-28c.md`: **8/9, first-pass commit 83.3%, escaped 0%, 0 errored, 1492.4s**). Added `good-multifile-method-labels` (a coordinated three-file migration) — it FAILS, and the failure is the finding: the worker's diff is correct and the critic returns `broken` @0.99 on two objections about code the diff does not contain, one of which requires proving an ABSENCE of callers, which cannot be attached (#147). Added and then DELETED `good-declared-docs-check` in the same session: it passed while proving nothing, because every task in all nine cases carried `success_commands: []` — `adr/009`'s prompt half zeroed the field it was written to protect (#148, gotcha 93), and a case can assert only an outcome (#149). Also shipped #138's first slice: `GET /projects/:id/guarantees` + the "What this project guarantees" screen, which finally renders each contract zone's own `why` sentence (present since s07, never displayed) and keeps "contract file unreadable" visibly distinct from "no zones declared". Live-verified in a browser. Operator context recorded: the harness is FIRST for his own repos; the polygon is a stand-in.
- **s61** — **THE PASS BAR WAS MET** (PR #145, closes #131 #132 #135 #136 #141 #143; CI 4/4; two codex review passes → 1 blocker + 4 majors → R2 SAFE). The session fixed the RULER, not the harness: the composer may only reference commands the project declares and the gate refuses to RUN one that does not exist (`adr/009`, the operator's #143 decision, both halves); a malformed decomposition is retried once (#141); a multi-task case is scored on its most decisive ESCALATION (#136); rates are measured over cases that produced a record, with `measured: X/Y` stated above the table; `escalations/` is purged per case (#131); and both Windows pre-run steps are gone (#132/#135). Corpus re-run: **7/7 passed, `first_pass_commit_rate` 50% → 100%, escaped-defect 0%, 0 errored** (`RESULTS-2026-07-28b.md`). Two live-only findings the tests could not reach: `git check-ignore` rejects `--literal-pathspecs` outright (the other half of #135), and a watchdog test raced a fixed 30ms sleep. New: gotcha 92, `adr/009`, and a narrowed rule on which oracle questions are his.
- **s60** — **`adr/008` MERGED + MEASURED** (PR #142, `be7fea6`, closes #140, CI 4/4, **9** gate rounds, R9 SAFE): a contract zone’s `path_globs` is its SCOPE, and a declared `contract.docPaths` path is outside zone checking. The gate found **ten** defects, all on “which files did this diff touch”, **none caught by the feature’s own tests**; two were blockers of one class (a strict parser checking LESS than the sloppy reader it replaced) now closed structurally. Corpus re-run: **the targeted case `good-docs-overview-note` COMMITTED** — the prediction held end-to-end — but `first_pass_commit_rate` stayed **50%**, because the INSTRUMENT lost two cases: the composer invented a `success_command` the project lacks (#143, new) and #141 recurred. Session resumed from repo state after the terminal was closed. New: gotcha 91, issue #143.
- **s59** — **`adr/007` MERGED** (PR #139, `1b99e29`, CI 4/4, **7** critic rounds, R7 SAFE): the critic's mandate narrows on an operator-declared `contract.docPaths`, never on inferring what is prose. Live-verified on hashed prompts (4/4 `clean` declared vs 4/5 `uncertain` undeclared; 3/3 non-clean on a rewrite). **Corpus re-run: `first_pass_commit_rate` 50% → 50% — the metric did NOT move.** The critic now returns `clean` @0.99 on the docs case, but the MECHANICAL gate escalates it `needs-guard`: documenting a contract value counts as touching it (#140). The 4/7 → 5/7 is #136 noise, not catching power; `good-wc-compat-hpos-flag` errored on a decomposition-shape fault (#141). New: gotcha 89, issues #138/#140/#141, two operator rules in `AGENTS.md`.
- **s58** — **#123 FIXED AND MEASURED**: the critic sees whole changed files, not just the hunk (PR #134, `ebb85ea`, CI 4/4, 4 codex rounds, R4 SAFE). Corpus re-run: `first_pass_commit_rate` **0% → 50%**, escaped-defect still 0%, 2/7 → 4/7 — **pass bar still not met**. Mechanism proven by a paired live-critic control (`uncertain` 0.88 → `clean` 0.99). `adr/007` decided + live-verified (mandate narrowing for code-free diffs). R3's regression test exposed 11 pre-existing instances of the same defect class in `conductor.ts`. New: gotchas 87/88, issues #133/#135/#136.
- **s57** — **Corpus diagnostics MERGED** (#126, PR #130, `21c2c41`, CI 4/4) after **7 codex rounds** — 25 findings: 21 real, 2 disproved on facts, 2 unreachable by measurement, 2 declined. Rounds 2–5 each found a narrower defect inside the previous fix; one shape 4× → new gotcha `[logic/ambiguous-false]` (86). Mid-session the critic hit its quota, blocking gate AND corpus → `[ops/codex-quota-exit-zero]` + #129; operator renewed the subscription. Also: full docs audit (CURRENT-STATE 287→~165), #104 closed as already-shipped, #131/#132 filed. **#123 NOT started — the metric was not re-measured.**
- **s56** — **Evaluation Corpus Phase 2 MERGED** (PR #128, `3191a76`, CI 4/4; codex R1–R4 NOT SAFE → R5 SAFE; closes #121). Live run: **2/7, pass bar NOT met** — escaped-defect **0%** (catching works), first-pass commit **0%** (throughput doesn't). Root cause: the critic sees only the diff hunk (GOTCHAS 84, #123). Findings #123–#126 open, #127 fixed in-PR on the operator's word, #122 (board auto-add) filed. Five sessions of green live proofs missed this because all of them were additive.
- **s55** — Tail-clearing + capstone-start, **4 PRs merged**: #118 (s54 docs tail), #119 (tech-debt #85 flaky-clock de-flake + #106 critic-unavailable, both issues closed), #120 (Evaluation Corpus **Phase 1** machinery — 5 pure `src/eval/` modules). All codex R→R SAFE. Fixed a mis-filed board card (#116 off board #5). Corpus Phase 2 → issue #121. Operator feedback (hard): stop over-asking/checkpointing — execute the whole chain to merge.
- **s54** — Mandatory Anti-Drift + North-Star **MERGED** (PR #117, `955e05b`, last `adr/004` slice; codex R1→fix→R2 SAFE; live-proven 3 ways) + backlog reconciliation (6 stale-done closed). Incident: a `git reset --hard` to sync main discarded the operator's uncommitted `package.json`/lock/`.claude/settings.json` (GOTCHAS 82).
- **s53** — CRLF papercut merged (PR #114) + Morning Report merged (PR #115) + mandatory-anti-drift spec'd.
- **s52** — the two reports (Execution + Qualification) + evidence ledger (PR #113, `4fc1e87`).
- **s51** — Profiles / WP-WC Qualification Layer v1 + `adr/006` Phase 3 (`ee0be38`).
- **s50** — `adr/006` Phase 2: protected-oracle-path fence (`44aebd8`) + docs audit (`0a89a45`).
- **s49** — `adr/006` Phase 1: trusted-root oracle definitions (`cc0db6f`).
- **s48** — Authority Model audit + `adr/006` + `PRINCIPLES.md` #14/#15 (`c6c2343`).
- **s47** — docs consolidation + external review → the Profiles thrust (`7759346`).
- **s46** — overnight presence toggle, `adr/004` slice 2 (`680b9fa`).
- **s45** — overnight escalation supervisor, `adr/004` slice 1 (PR #76).
- **s44** — `gpt-5.6-luna` promoted as critic + reply-B poison fix.
- **s43** — reply-B cycle live-proven + `blocked` state (PR #74).
- **s42** — `adr/005` critic-is-a-correctness-gate (PR #73).
- **s41** — first real CI run on a real task, end-to-end DONE (`3609a2c`).

## Environment (verified s58)

- **Daemon:** `node dist/index.js serve` (:4319, daemon-global, serves `dist/ui`) or `node dist/index.js run` (headless, from the project dir). **Rebuild BOTH bundles** after backend changes (`npm run build` AND `npm run build:ui`).
- **Corpus:** `node dist/index.js eval [--corpus <dir>] [--baseline <commit-ish>] [--max-iterations <n>] [--out <file>]`, on demand only — it drives real worker/critic calls. A 7-case run takes ~11 min. TWO manual steps on Windows (#132): set `gate.agentCi: false` in the target project first (agent-ci cannot run natively and would escalate every case for an environment reason), and pass `--artifacts <dir OUTSIDE the repo>` — with the default path the run refuses to start, because `git check-ignore` reads the Windows drive-letter colon as pathspec magic (#135, gotcha 88). Clear the queue first: the preflight refuses if any task is live.
- **Presence store:** `~/.autodev/settings.json` (`{overnight:{enabled}}`); `GET`/`PATCH /settings`. Per-project opt-in: `autonomy.overnight.enabled` in the project `.autodev/config.yaml`. Overnight runs on the AND, presence read fresh per trigger.
- **Test repo:** `woodev-shipping-plugin-test` (registry `~/.autodev/projects.json`, path `D:\Projects\wordpress\woodev-shipping-plugin-test`, on `autodev/main`). `.autodev` is git-excluded, so seeding never dirties the tree.
- **Operator repo (the real target):** `woodev-base-theme`, harness clone at `D:/Projects/woodev_base_theme_autodev`, on `autodev/main` — **now pushed to `origin`** (s65), with `.autodev/` and `.serena/` in `.git/info/exclude`. His own working copy `D:\Projects\woodev_base_theme` is never touched; he merges what the clone produces. **CI evidence comes from a PR, not from the push** — `ci.yml` fires on `push: branches: [main]` and `pull_request` only. Verify a daemon restart picks up a fresh `dist`: s65 found one serving a bundle older than the s64 `#155` fix.
- **Critic:** codex, **pin `--model gpt-5.6-luna`**. Run it DIRECTLY — `cat prompt.txt | codex exec --model gpt-5.6-luna --skip-git-repo-check -` (synchronous, prompt on STDIN because a large prompt exceeds the Windows argument limit). Not via the background companion: `/codex:cancel` is broken under git-bash and can leave a job wedged (`[ops/codex-cancel-broken-under-git-bash]`), and a quota refusal exits 0 with no verdict (`[ops/codex-quota-exit-zero]`).
- **Tests:** 1961 green + 3 skipped; `npm run typecheck` clean (`tsconfig.typecheck.json` — the emit tsconfig does NOT cover `test/**`).
- **Corpus pre-flight, BY EXACT NAME** (gotcha 89): `.autodev/corpus.lock` must not exist (a KILLED run leaves it, and the next run then produces a report shaped like a catastrophic regression — the tells are wall-clock `0.0s` and tokens `0/0`); the three `queue/` dirs empty; `git status` clean; HEAD at the intended `--baseline`. Launch DETACHED (`Start-Process`), never as a bash background job.

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `DOCS-INDEX.md` — where every other doc lives.
- `adr/004` — live-orchestrator presence + post-review autonomy (both halves now shipped).
- `FUTURE-BACKLOG.md` — FROZEN; open items are GitHub issues on board #2.
