# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s57)

A working **Node daemon + web dashboard**, and — since s56 — a **measured** one. `main` is at
**`21c2c41`**. s57 shipped the corpus's diagnostics layer (#126, PR #130, CI 4/4) through
**seven codex `gpt-5.6-luna` rounds**, and did NOT get to the number it set out to move.

**The measurement still stands unchanged** — `first_pass_commit_rate: 0%`, the whole point of
#123, was not re-run. #126 makes the next run *readable*; it does not move the metric, and it
must not be reported as if it did.

The two halves of the harness still measure opposite things:

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

**What s57 added to that:** the gate cost seven rounds on ~200 lines, and rounds 2–5 each found
a narrower defect *inside the previous round's own fix*. One shape appeared four times — a
boolean whose `false` means both "no" and "I could not determine" (`[logic/ambiguous-false]`).
Two findings were real enough to have made the feature harmful: the diagnostics could dirty the
target repo and break the measurement they exist to explain, and a broken git index authorized
writing into the work tree. Detail → `SESSION-LOG.md` s57.

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
| Corpus run diagnostics (#126) | ✅ shipped + MERGED s57 (PR #130, `21c2c41`, CI 4/4) — per-case artifact archive + raw-evidence run manifest; 7 codex rounds. Makes a failed case readable; does NOT move the metric |
| Critic evidence window (#123) | ❌ **BROKEN — the top open defect.** Prompt carries `diff.patch` only ⇒ a clean verdict is unreachable for any change referencing context outside the hunk. Blocks correct work; measured, not inferred. |
| Critic availability | ✅ restored 2026-07-26 (subscription renewed). Residual: ONE provider is both the review gate and the harness's own critic, so a single outage blocks merging AND measuring — needs a second *calibrated* critic (#129) |

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

1. **(TOP) #123 — widen the critic's evidence window, and MEASURE it.** The single defect behind
   `first_pass_commit_rate: 0%`, and the deliverable s57 did not reach. Plumbing already
   scouted: `conductor.ts:752` captures the diff via `worktree.diff` → `git.ts:142`, which runs
   a bare `git diff` with **no `-U`**; `CriticRunInput` (`critic/adapter.ts`) is where an
   attachment field goes. Cheapest first: widen the diff context, then attach the full text of
   each changed file within a stated byte budget. Budget is **measured**, not guessed: the files
   corpus cases touch are 281–1412 bytes, the polygon's largest is 136 KB, and codex digested an
   88 KB prompt in the s57 gate — so ~64 KB per file / ~256 KB total attaches everything
   realistic. **Never attach a TRUNCATED file** — that manufactures a NEW false `broken` ("the
   constant isn't declared") which does not exist today. Do NOT give codex file access (its
   Windows sandbox blocks it, `[critic/codex]`).
   **The deliverable is the before/after number, not the code:** re-run `eval`, write the run to
   `corpus/RESULTS-<date>.md`, put both numbers side by side. If it does not move, say so plainly.
   Watch for: the docs-only case may STILL fail on "cannot independently verify these factual
   claims", which is a MANDATE question, not an evidence one — that would be an ORACLE-level
   finding for the operator with one concrete proposal (an `adr/007` narrowing the critic's
   mandate the way `adr/005` narrowed it off coverage), never a pre-emptive loosening.
2. **#124** (a `broken` verdict whose escalation names no defect) · **#125** (`critic_total`
   tokens always 0, so every report understates cost by the critic's whole share).
3. **#129** — the critic is a single point of failure: one quota outage blocked both the gate
   and the measurement, and s57's gate then took 7 rounds on one module. A second *calibrated*
   critic in the roles matrix is not a luxury.
4. **Operator's triage:** #131 (corpus `escalations/` not purged between cases — three options,
   one of which changes the reset contract) · #132 (two manual pre-run steps on Windows).
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
