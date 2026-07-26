# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## ⛔ BLOCKED (s57, 2026-07-26) — the critic is out of quota

`codex exec` refuses every call: **usage limit, retry after 2026-08-24**. The operator will
renew the subscription; until then **nothing merges and no corpus runs**, because the same
provider is both the review gate and the harness's own critic — see
`gotchas/codex-quota-exit-zero-blocks-gate-and-corpus.md` (note: a quota refusal **exits 0**
with no verdict, so a "completed" gate run can be empty).

- **Issue #126 is BUILT but NOT GATED** — branch `feat/corpus-diagnostics`, commit `ff5aec7`.
  Per-case artifact archive + raw-evidence run manifest; 33 new tests (1829 green), typecheck
  clean. That is mechanical verification, **not** the gate. First action next session: run the
  codex gate on it, fix, re-gate, then PR.
- **Issue #123 NOT STARTED** — deliberately. Its whole deliverable is a before/after
  `first_pass_commit_rate`, which cannot be measured while the corpus's critic is down.

## Where we are

A working **Node daemon + web dashboard**, and — since s56 — a **measured** one. `main` is at
**`3191a76`**. The whole architecture-review chain has shipped, and its last link (the
Evaluation Corpus) immediately measured the two halves of the harness saying opposite things:

| | Measured (2026-07-26, 7 cases) | Meaning |
|---|---|---|
| **Catching power** | `escaped_defect_rate: 0%` (3/3 adversarial caught) | The thing the project claims — "never merge bullshit" — **holds**. |
| **Throughput** | `first_pass_commit_rate: 0%` (0/4 good cases landed) | Correct work does not get through. |

**2/7 cases passed; the pass bar is NOT met.** Not a green capstone, and must not be reported
as one. Full run: `corpus/RESULTS-2026-07-26.md` — the number to beat.

Two distinct causes, which the Corpus Report cannot yet tell apart (#126):
1. **The critic's evidence window is the diff hunk** — the important one (#123, GOTCHAS 84
   `[critic/diff-hunk-only-evidence]`). It reasons fail-closed and its prompt carries only
   `diff.patch`, so a clean verdict is structurally unreachable for any change whose
   correctness depends on code outside the changed lines.
2. **Attempt-budget exhaustion** against the profile gate → `poison` → `quarantine`.

**The transferable lesson:** every prior committing live proof was additive and self-contained,
so five sessions of green proofs said nothing about edits. Green proofs characterize the
harness only over the shapes of work they contain — which is what an evaluation corpus is for,
and it closed that gap on its first run. Detail → `SESSION-LOG.md` s56.

## Phase status

| Area | Status |
|---|---|
| Core loop (P1, headless) | ✅ shipped, parity-proven against the PS oracle |
| Web dashboard (P2) | ✅ product-track items 1–4 done; general polish ongoing |
| Attended live-orchestrator presence (`adr/004`) | ✅ shipped (s40, PR #72) |
| Unattended autonomy (`adr/004`) | ✅ COMPLETE — all four slices (overnight supervisor s45, presence toggle s46, morning report s53, mandatory anti-drift + north-star s54) |
| Critic model | ✅ codex `gpt-5.6-luna` (calibrated s44; **pin it**) |
| Authority Model (`adr/006`) | ✅ Phase 1 (s49) + Phase 2 (s50) + Phase 3 (s51, via Profiles) shipped |
| Profiles / Qualification Layer | ✅ v1 shipped (s51) -- 2 facets (`gates` + `protectedPaths`), WP/WC first |
| Gate feedback on RETRY | ✅ shipped (s51) -- the worker now sees WHY the gate rejected it |
| Line-scoped profile gates | ✅ shipped (s51, `c1ff87e`) -- `wordpress-woocommerce@2`; the worker owns the lines it wrote |
| Reporting (Execution + Qualification + Morning) | ✅ shipped s52–s53 — per-task evidence ledger + all three report types |
| Evaluation Corpus | ✅ shipped s55–s56 — machinery + real executor + `eval` CLI + 7 authored cases; **run live, pass bar NOT met** |
| Corpus run diagnostics (#126) | 🟡 BUILT, NOT GATED — `feat/corpus-diagnostics` `ff5aec7`; see the BLOCKED block above |
| Critic evidence window (#123) | ❌ **BROKEN — the top open defect.** Prompt carries `diff.patch` only ⇒ a clean verdict is unreachable for any change referencing context outside the hunk. Blocks correct work; measured, not inferred. |
| Critic availability | ❌ **OUT OF QUOTA until 2026-08-24** — blocks the gate AND the corpus (#129) |

> Per-feature shipping history (which PR, which commit, how many critic rounds) belongs in
> `SESSION-LOG.md`, not here — this table is the live status only (`DOCS-SCHEMA.md`).

## The thrust — SHIPPED END TO END (s49 → s56)

```text
Authority Model  →  Profiles / Qualification Layer  →  two reports  →  Evaluation Corpus
```

Every link of `wiki/architecture-review-external-2026-07.md`'s chain has landed: Authority
Model (`adr/006` Phase 1 s49, Phase 2 s50, Phase 3 folded into Profiles s51) → Profiles v1
(s51) → the two reports (s52) → the Evaluation Corpus (Phase 1 s55, Phase 2 s56). The
per-link detail is in `SESSION-LOG.md`; this file no longer restates it.

**So the project's mode has changed.** The corpus, the chain's last link, replaced "build the
next thing" with "fix what the measurement just found" — and the first thing it found is that
the harness catches everything and passes nothing (#123). Deferred by design: the remaining
five profile facets (#88) and PHPStan as a gate (#87).

## NEXT ACTIONS

**Everything below is gated on the critic being back (see the BLOCKED block at the top).**

1. **Gate the s57 work — #126, commit `ff5aec7`** on `feat/corpus-diagnostics`. Built, tests
   green, NOT reviewed. Run the codex gate → fix → re-gate → PR → green CI → merge.
2. **Then #123 — widen the critic's evidence window, and MEASURE it.** The single defect
   behind `first_pass_commit_rate: 0%`. Cheapest first: widen the diff context (`-U`), attach
   the full text of each changed file within a stated byte budget; do NOT give codex file
   access (its Windows sandbox blocks it). Never attach a TRUNCATED file — that invites a new
   false-broken. **The deliverable is the before/after number**, not the code: re-run `eval`
   and put it beside `corpus/RESULTS-2026-07-26.md`. If the number does not move, say so.
3. **#124** (a `broken` verdict whose escalation names no defect) · **#125** (`critic_total`
   tokens always 0, so every report understates cost by the critic's whole share).
4. **#129** — the critic is a single point of failure: one quota outage blocked both the gate
   and the measurement. Needs a second *calibrated* critic in the roles matrix.
5. **#122** — autodev-harness cards auto-add onto the Woodev boards #5/#6; fixable only in the
   board UI, so it is the operator's. Remind once; do not keep sweeping cards by hand.

`FUTURE-BACKLOG` is FROZEN; open items are GitHub issues on board #2.

## Open questions

- **PHPStan in a profile.** Deliberately not a v1 gate: useful WordPress analysis needs
  `szepeviktor/phpstan-wordpress`, whose `extension.neon` a profile-shipped config cannot
  portably reference (a neon `includes:` resolves relative to the neon file, which lives
  in the harness repo where no project `vendor/` exists). Measured: without it, a correct
  file draws 14 phantom "unknown class/function" findings. Needs a way for a profile to
  inject a project-resolved autoload/extension path.
- **The analyzer toolchain is project-controlled.** A profile's gates run
  `vendor/bin/phpcs`, and `vendor` comes from the project's own `composer.json`, so a
  worker could in principle weaken the analyzer itself. Named residual, not closed: no
  mechanical rule separates "a project script" from "a project binary", so pretending a
  check closes it would be worse than naming it.
- **Oracle protection for `success_command`/`checkCommand` implementations** — they are
  commands, not declared paths, so Phase 2 protects them only when the operator lists
  them in `constitutionPaths`. Deriving a path set from a command string is not reliably
  decidable; is an explicit per-command path declaration worth the config surface?
- **Does a second critic need operator consent to take over?** (#129) A silent automatic
  fallback to a different critic changes the acceptance bar without anyone saying so — but
  a fallback that waits for a human is not a fallback when the outage happens overnight.

## Recent sessions (full detail → `SESSION-LOG.md`)

> One line each — pointers, not summaries. Detail belongs in `SESSION-LOG.md`.

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

## Environment (verified s57)

- **Daemon:** `node dist/index.js serve` (:4319, daemon-global, serves `dist/ui`) or `node dist/index.js run` (headless, from the project dir). **Rebuild BOTH bundles** after backend changes (`npm run build` AND `npm run build:ui`).
- **Corpus:** `node dist/index.js eval [--corpus <dir>] [--baseline <commit-ish>] [--max-iterations <n>] [--out <file>]`, on demand only — it drives real worker/critic calls. A 7-case run takes ~12 min; set `gate.agentCi: false` on Windows first (agent-ci cannot run natively and would escalate every case for an environment reason).
- **Presence store:** `~/.autodev/settings.json` (`{overnight:{enabled}}`); `GET`/`PATCH /settings`. Per-project opt-in: `autonomy.overnight.enabled` in the project `.autodev/config.yaml`. Overnight runs on the AND, presence read fresh per trigger.
- **Test repo:** `woodev-shipping-plugin-test` (registry `~/.autodev/projects.json`, path `D:\Projects\wordpress\woodev-shipping-plugin-test`, on `autodev/main`). `.autodev` is git-excluded, so seeding never dirties the tree.
- **Critic:** codex, **pin `--model gpt-5.6-luna`**. Run it DIRECTLY — `cat prompt.txt | codex exec --model gpt-5.6-luna --skip-git-repo-check -` (synchronous, prompt on STDIN because a large prompt exceeds the Windows argument limit). Not via the background companion: `/codex:cancel` is broken under git-bash and can leave a job wedged (`[ops/codex-cancel-broken-under-git-bash]`), and a quota refusal exits 0 with no verdict (`[ops/codex-quota-exit-zero]`).
- **Tests:** 1829 green + 3 skipped; `npm run typecheck` clean (`tsconfig.typecheck.json` — the emit tsconfig does NOT cover `test/**`).

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `DOCS-INDEX.md` — where every other doc lives.
- `adr/004` — live-orchestrator presence + post-review autonomy (both halves now shipped).
- `FUTURE-BACKLOG.md` — FROZEN; open items are GitHub issues on board #2.
