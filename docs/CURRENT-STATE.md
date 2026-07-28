# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s62)

A working **Node daemon + web dashboard**. s61 met the pass bar on seven cases; **s62 made the
corpus able to fail again, and it immediately did** — which is the first time in four runs that
the instrument reported something instead of confirming.

| | s59 | s60 | s61 | **s62** | Meaning |
|---|---|---|---|---|---|
| **Throughput** — `first_pass_commit_rate` | 50% | 50% | 100% | **83.3%** | one good case does not commit — and should |
| **Catching power** — `escaped_defect_rate` | 0% | 0% | 0% | **0%** | 3/3 adversarial escalated |
| Cases passed | 5/7 | 5/7 | 7/7 | **8/9** | pass bar **NOT met — deliberately** |
| Cases measured | — | — | 7/7 | **9/9** | 0 errored |

`corpus/RESULTS-2026-07-28c.md`, 1492.4s, baseline `fb21553`.

**The failing case is the deliverable.** `good-multifile-method-labels` asks for a coordinated
three-file migration (a new constant class, a rewritten `get_label()`, a `require_once`). The
worker's diff is CORRECT. The critic returned `broken` **@0.99** on two objections that are
both about code the diff does not contain: callers that might pass the old ids (the repo has
none) and a hypothetical standalone include (which the require order it also notes makes
moot). `#123` widened the critic's evidence window to whole **changed** files; this case stands
one step past that edge, where the deciding facts live in **unchanged** files — and one of them
is an **absence**, which cannot be attached at all. The worker has no way to argue back, so a
correct change of this class parks every time (**#147**).

**A case was deleted one run after it was added.** `good-declared-docs-check` asserted that a
command the project DECLARES is kept by the composer, pre-flighted, and actually RUN. It
PASSED and proved none of it: every task in every case carried `success_commands: []`, because
`adr/009`'s prompt half tells the model that omitting the field is normal. The command reached
the task's `acceptance` prose and never the gate; `success_green: true` meant "nothing to run"
(**#148**, gotcha 93). The case could not have failed for its stated reason, because a case can
only assert an OUTCOME while the property lived in the task record (**#149**).

**#138 shipped its first real slice.** `GET /projects/:id/guarantees` + a "What this project
guarantees" screen: contract zones **with their own `why` sentence** (that text has been in
every `INVARIANTS.md` since s07 and had never been rendered anywhere), the profile's gates and
what each is scoped to, protected paths, the critic and its mandate, the retry budget before a
task parks. Live-verified in a browser against the polygon. The distinction the screen turns
on: `invariantsReadable === false` is NOT `zones: []` — the gate's own loader folds them
together (correct for the gate), and folded here it would show a calm empty list for a project
enforcing nothing.

**The critic's token count is still `0`** in the report (#125).

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
| Evaluation Corpus | ✅ machinery + `eval` CLI + **8 cases**; run SIX times. s61 met the bar 7/7; **s62 deliberately broke the ceiling: 8/9, first-pass commit 83.3%, escaped 0%, 0 errored** — the corpus can fail again and does (#147). One case deleted the same run for passing vacuously (#148/#149) |
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
> convenient; a capability proven only there is not proven for him. He also said plainly that
> he no longer understands what is being built or why, and sees no product progress — which is
> what moved #138 to the top and what item 1 below is about.

1. **Run the harness on a REAL woodev repo, not the polygon.** Expect a lot to break: a real
   repo is larger, dirtier, carries actual phpcs/composer debt, and has no contract zones
   placed helpfully. The honest deliverable is the list of what falls over. This is the first
   measurement that means anything to the operator.
2. **#147 — the critic blocks a correct change whose correctness lives outside the diff, and
   the worker cannot argue back.** Measured, not suspected. Options are in the issue; the one
   that changes the most is giving the critic the CALLERS of the symbols a diff touches, so
   "nothing calls this" becomes a presentable fact instead of a guess.
3. **#148** — the composer never populates `success_commands`, so `adr/009`'s whole machinery
   is unexercised · **#149** — a corpus case can assert only an OUTCOME, so it can pass for
   the wrong reason (the enabler for re-adding the deleted case).
4. **#138 continues** — corpus metrics in the UI; per-field explanations (#96).
5. **#125** (`critic_total` always `0` — this run reports `72867 / 0`) · **#124** · **#129**
   (one provider is both the review gate and the harness's own critic) · **#133** · **#122**.
6. Remaining #146 shapes: a second adversarial case aimed at the CRITIC, and a genuinely
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
- **Critic:** codex, **pin `--model gpt-5.6-luna`**. Run it DIRECTLY — `cat prompt.txt | codex exec --model gpt-5.6-luna --skip-git-repo-check -` (synchronous, prompt on STDIN because a large prompt exceeds the Windows argument limit). Not via the background companion: `/codex:cancel` is broken under git-bash and can leave a job wedged (`[ops/codex-cancel-broken-under-git-bash]`), and a quota refusal exits 0 with no verdict (`[ops/codex-quota-exit-zero]`).
- **Tests:** 1961 green + 3 skipped; `npm run typecheck` clean (`tsconfig.typecheck.json` — the emit tsconfig does NOT cover `test/**`).
- **Corpus pre-flight, BY EXACT NAME** (gotcha 89): `.autodev/corpus.lock` must not exist (a KILLED run leaves it, and the next run then produces a report shaped like a catastrophic regression — the tells are wall-clock `0.0s` and tokens `0/0`); the three `queue/` dirs empty; `git status` clean; HEAD at the intended `--baseline`. Launch DETACHED (`Start-Process`), never as a bash background job.

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `DOCS-INDEX.md` — where every other doc lives.
- `adr/004` — live-orchestrator presence + post-review autonomy (both halves now shipped).
- `FUTURE-BACKLOG.md` — FROZEN; open items are GitHub issues on board #2.
