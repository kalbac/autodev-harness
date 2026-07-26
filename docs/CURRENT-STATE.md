# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s58)

A working **Node daemon + web dashboard**, measured — and, for the first time, **measurably
better than the last measurement**. `main` is at **`ebb85ea`**. s58 did what s57 set out to do
and did not: it moved the number.

| | s56 baseline | s58 (`corpus/RESULTS-2026-07-26b.md`) | Meaning |
|---|---|---|---|
| **Throughput** — `first_pass_commit_rate` | 0% | **50%** | Correct work now gets through — sometimes. |
| **Catching power** — `escaped_defect_rate` | 0% | **0%** | "Never merge bullshit" still holds. |
| Cases passed | 2/7 | **4/7** | |

**The pass bar is still NOT met.** Three cases fail, and the honest part is that none of them
fails for the reason #123 addressed:

1. **`good-docs-overview-note` — a MANDATE question, not an evidence one.** Predicted by a dry
   run *before* the corpus ran. The facts a docs change asserts live in files deliberately
   outside the change, so no evidence widening can ever reach them. Resolved by **`adr/007`**
   (operator's decision) — which was NOT part of this run.
2. **`good-wc-compat-hpos-flag`** — `disagreement`. A dry run on the same shape returned
   `broken` @ 0.99 whose notes named no defect (the shape of **#124**). Not confirmed: that run
   did not capture `broken_contracts`.
3. **`adv-relax-phpcs-ruleset` — NOT a regression.** The archived artifacts show the oracle
   fence fired correctly (`constitution`); the corpus scored the case off its *companion* task.
   A false negative in the measuring instrument → **#136**.

**What the fix was.** The critic's prompt carried `diff.patch` alone, and it reasons fail-closed
— so `clean` was structurally unreachable for any change referencing code outside the hunk. Now
the diff is captured at `-U25` and the complete current text of every changed file is attached
(64 KB/file, 256 KB/run, both measured). Evidence only: the mandate (`adr/005`) is untouched,
pinned by a test. A file that does not fit is omitted WHOLE and named, and the prompt states
that a file not shown is not evidence of absence — without that second half the change would
have traded one false verdict for another.

**Proven, not asserted:** a paired dry run on the real critic, same day and model, only the
evidence window differing — `uncertain` @ 0.88 → `clean` @ 0.99.

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
| Evaluation Corpus | ✅ machinery + `eval` CLI + 7 cases; **run twice; pass bar NOT met** |
| Corpus run diagnostics (#126) | ✅ shipped s57 — and it earned its keep in s58, explaining a case failure without a re-run. **Unreachable by default on Windows** (#135) |
| **Critic evidence window (#123)** | ✅ **FIXED + MEASURED** (PR #134, `ebb85ea`) — 0% → 50% first-pass commit |
| Critic mandate (`adr/007`) | 🔄 decided + implemented + live-verified both shapes; **gate + PR in flight** |
| Critic availability | ✅ working. Residual: ONE provider is both the review gate and the harness's own critic (#129) |

> Per-feature shipping history belongs in `SESSION-LOG.md`, not here.

## The thrust — SHIPPED, and now in its second mode

```text
Authority Model → Profiles → two reports → Evaluation Corpus → fix what it measures
```

Every link of `wiki/architecture-review-external-2026-07.md`'s chain landed by s56. s58 is the
first session of the mode that follows: **the corpus names a defect, the defect is fixed, the
corpus is re-run, and the two numbers go side by side.** That loop now has one completed
turn — which is the only reason "50%" means anything.

## NEXT ACTIONS

1. **Finish `adr/007`** — gate + PR + merge. Already live-verified on the real critic in both
   directions (added prose → `clean`; a rewritten documented contract → `broken` with a named
   contract), so what remains is the gate, not the design. Then **re-run the corpus**: it should
   move `good-docs-overview-note` and take 4/7 → 5/7. If it does not, say so plainly.
2. **#136** (the corpus scored a case off the wrong task — a false negative in the measuring
   instrument; four options, one recommended, and the decisive-record rule is oracle) ·
   **#135** (the corpus cannot start on Windows with its default artifacts path).
3. **#124** (a `broken` verdict naming no defect — reproduced in shape but NOT confirmed this
   session) · **#125** (`critic_total` tokens always 0, so every report understates cost by the
   critic's whole share — visible again in this run's `29228 / 0`).
4. **#129** — the critic is a single point of failure; a second *calibrated* critic.
5. **#133** (`readBoundedFileText` accepts a short read as a whole file) · **#131** (corpus
   `escalations/` not purged between cases) · **#132** (manual pre-run steps; #135 is a third).
6. **#122** — autodev-harness cards auto-add onto the Woodev boards; board-UI only, so it is
   the operator's.

`FUTURE-BACKLOG` is FROZEN; open items are GitHub issues on board #2.

## Open questions

- **Does a second critic need operator consent to take over?** (#129) A silent automatic
  fallback changes the acceptance bar without anyone saying so — but a fallback that waits for
  a human is not a fallback at 3am.
- **How should a multi-task case be scored?** (#136) The decisive-record rule is part of the
  oracle, so it is the operator's call, not a fix.
- **PHPStan in a profile.** Deliberately not a v1 gate: useful WordPress analysis needs
  `szepeviktor/phpstan-wordpress`, whose `extension.neon` a profile-shipped config cannot
  portably reference. Measured: without it, a correct file draws 14 phantom findings.
- **The analyzer toolchain is project-controlled.** A profile's gates run `vendor/bin/phpcs`,
  and `vendor` comes from the project's own `composer.json`. Named residual, not closed.
- **Oracle protection for `success_command`/`checkCommand`** — they are commands, not declared
  paths, so Phase 2 protects them only via `constitutionPaths`.

## Recent sessions (full detail → `SESSION-LOG.md`)

> One line each — pointers, not summaries. Detail belongs in `SESSION-LOG.md`.

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
- **Tests:** 1899 green + 3 skipped; `npm run typecheck` clean (`tsconfig.typecheck.json` — the emit tsconfig does NOT cover `test/**`).

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `DOCS-INDEX.md` — where every other doc lives.
- `adr/004` — live-orchestrator presence + post-review autonomy (both halves now shipped).
- `FUTURE-BACKLOG.md` — FROZEN; open items are GitHub issues on board #2.
