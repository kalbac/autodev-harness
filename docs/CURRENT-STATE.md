# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s61)

A working **Node daemon + web dashboard**, measured five times — and this is the run where
**the pass bar was met for the first time.**

s61 fixed the RULER, not the harness: six defects in the Evaluation Corpus and its inputs,
as one pass (PR #145, closes #131 #132 #135 #136 #141 #143). Then it re-ran the corpus
(`corpus/RESULTS-2026-07-28b.md`, 691.8s, baseline `fb21553`, default artifacts path).

| | s58 | s59 | s60 | **s61** | Meaning |
|---|---|---|---|---|---|
| **Throughput** — `first_pass_commit_rate` | 50% | 50% | 50% | **100%** | all four good cases committed, every one on the first pass |
| **Catching power** — `escaped_defect_rate` | 0% | 0% | 0% | **0%** | "never merge bullshit" holds — 3/3 adversarial escalated |
| Cases passed | 4/7 | 5/7 | 5/7 | **7/7** | pass bar **MET** |
| Cases measured | — | — | — | **7/7** | 0 errored: the instrument ate nothing |

**What actually changed.** Nothing in this session touched the gate's judgement. Three of the
four good cases were being lost to the instrument or its inputs, and each loss is now closed
at its cause:

- `good-bugfix-supported-zones` — quarantined in s60 with correct code and an approving
  critic, because the composer invented `pnpm lint:php:changes` → **committed** (#143).
- `good-wc-compat-hpos-flag` — errored in two consecutive runs on a malformed decomposition
  → **committed** (#141, one retry with the validation error fed back).
- `adv-relax-phpcs-ruleset` — scored off the wrong record in s58 → now scored on its
  `constitution` catch (#136).
- `good-docs-overview-note` — the case `adr/008` targeted in s60 — **stayed** committed.

**What this number does and does not say.** It says: on these seven cases, the harness
committed everything that should land and caught everything that should not, first try. It
does not say the harness got better this session — `adr/007` and `adr/008` did that work, and
until now the ruler was hiding it. Seven cases is also a small corpus: the honest next move is
to make it harder, not to celebrate 100%.

**The critic's token count is still `0`** in the report (#125) — the run cost is understated
by the critic's whole share.

## Phase status

| Area | Status |
|---|---|
| Core loop (P1, headless) | ✅ shipped, parity-proven against the PS oracle |
| Web dashboard (P2) | ✅ product-track items 1–4 done; general polish ongoing |
| Attended live-orchestrator presence (`adr/004`) | ✅ shipped (s40, PR #72) |
| Unattended autonomy (`adr/004`) | ✅ COMPLETE — all four slices |
| Critic model | ✅ codex `gpt-5.6-luna` (calibrated s44; **pin it**) |
| Authority Model (`adr/006`) | ✅ Phase 1 + 2 + 3 shipped |
| Profiles / Qualification Layer | ✅ v1 shipped (s51) — 2 facets, WP/WC first |
| Reporting (Execution + Qualification + Morning) | ✅ shipped s52–s53 |
| Evaluation Corpus | ✅ machinery + `eval` CLI + 7 cases; run FIVE times; **pass bar MET (s61): 7/7 passed, 100% first-pass commit, 0% escaped, 0 errored.** Its own six defects are closed (#131 #132 #135 #136 #141 #143) — the ruler no longer eats cases |
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

1. **Make the corpus harder — 7/7 on seven cases is a ceiling, not a result.** The cases were
   written when the harness could pass none of them; four of the five metrics are now
   saturated. Add cases the harness plausibly FAILS: a multi-file refactor, a change whose
   correctness lives in a file the diff does not touch, an adversarial case aimed at the
   critic rather than at a mechanical zone, a task whose spec is genuinely ambiguous. A corpus
   that cannot fail measures nothing (Principle 15 — the asset is the set of provable
   properties, and it grows only by formalizing more).
2. **#138 — make the harness legible.** The operator can no longer tell what the harness does
   or why. `adr/007`, `adr/008` and now `adr/009` each shipped with their dashboard row;
   everything from `adr/006` back did not. Start with the "what does this project actually
   guarantee" screen.
3. **#125** — `critic_total` tokens are always `0`; this run reports `37900 / 0`, understating
   the cost by the critic's whole share. It is the one number in the report that is knowably
   wrong. · **#124** (a `broken` verdict naming no defect).
4. **#129** — one provider is both the review gate and the harness's own critic.
5. **#133** (`readBoundedFileText` accepts a short read as a whole file) · **#122** (board
   auto-add — and note that `gh project item-add` exited 0 without adding the card in s60;
   the GraphQL mutation worked. Verify, never assume).

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
  and `vendor` comes from the project's own `composer.json`. Named residual, not closed.
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
- **Critic:** codex, **pin `--model gpt-5.6-luna`**. Run it DIRECTLY — `cat prompt.txt | codex exec --model gpt-5.6-luna --skip-git-repo-check -` (synchronous, prompt on STDIN because a large prompt exceeds the Windows argument limit). Not via the background companion: `/codex:cancel` is broken under git-bash and can leave a job wedged (`[ops/codex-cancel-broken-under-git-bash]`), and a quota refusal exits 0 with no verdict (`[ops/codex-quota-exit-zero]`).
- **Tests:** 1961 green + 3 skipped; `npm run typecheck` clean (`tsconfig.typecheck.json` — the emit tsconfig does NOT cover `test/**`).
- **Corpus pre-flight, BY EXACT NAME** (gotcha 89): `.autodev/corpus.lock` must not exist (a KILLED run leaves it, and the next run then produces a report shaped like a catastrophic regression — the tells are wall-clock `0.0s` and tokens `0/0`); the three `queue/` dirs empty; `git status` clean; HEAD at the intended `--baseline`. Launch DETACHED (`Start-Process`), never as a bash background job.

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `DOCS-INDEX.md` — where every other doc lives.
- `adr/004` — live-orchestrator presence + post-review autonomy (both halves now shipped).
- `FUTURE-BACKLOG.md` — FROZEN; open items are GitHub issues on board #2.
