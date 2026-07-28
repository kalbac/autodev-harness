# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s60)

A working **Node daemon + web dashboard**, measured three times. s60 landed the decision s59
handed the operator, and the honest headline is that **the code is in and the metric is not
re-measured yet.**

**`adr/008` MERGED** (PR #142, closes #140, CI 4/4, **nine** gate rounds, R9 SAFE). A contract
zone's `path_globs` is now the SCOPE of its string scan, and a path declared in
`contract.docPaths` is outside contract-zone checking. Documenting a contract value no longer
counts as changing it — which is the single thing that stood between `good-docs-overview-note`
and a commit in s59.

**What the review gate cost, and what it was worth.** Nine rounds, **ten defects**, every one
on the same boundary — *which files does this diff touch, and which lines belong to them* —
and **not one caught by the tests written with the feature**. Two were blockers of the same
class: a strict, correct parser checking LESS than the sloppy reader it replaced, letting a
diff that names a protected contract value reach `COMMIT`. That class is now closed
structurally (every line the flat reader produces must appear in the attributed output;
whatever is missing is added back unattributed), and the two shape-specific patches were
deleted after measuring that the guarantee alone keeps their tests green. New gotcha **91**.

| | s58 | s59 | s60 |
|---|---|---|---|
| **Throughput** — `first_pass_commit_rate` | 50% | 50% | **not re-measured** |
| **Catching power** — `escaped_defect_rate` | 0% | 0% | **not re-measured** |

**The number is the next step, not a claim.** `adr/008` is *expected* to take
`good-docs-overview-note` to a commit. Until the corpus runs again, that is a prediction.

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
| Evaluation Corpus | ✅ machinery + `eval` CLI + 7 cases; run three times; pass bar NOT met. Two of its own defects are load-bearing (#136, #141) |
| Corpus run diagnostics (#126) | ✅ shipped s57. **Unreachable by default on Windows** (#135) |
| Critic evidence window (#123) | ✅ FIXED + MEASURED (PR #134) — 0% → 50% first-pass commit |
| Critic mandate (`adr/007`) | ✅ MERGED (PR #139) — leniency scoped by an operator-declared `contract.docPaths` |
| **Contract-zone scope (`adr/008`)** | ✅ **MERGED** (PR #142, closes #140, CI 4/4, 9 rounds). **NOT yet re-measured against the corpus** |
| Critic availability | ✅ working. Residual: ONE provider is both the review gate and the harness's own critic (#129) |

> Per-feature shipping history belongs in `SESSION-LOG.md`, not here.

## The thrust — SHIPPED, and now in its second mode

```text
Authority Model → Profiles → two reports → Evaluation Corpus → fix what it measures
```

s58 was the first turn of *the corpus names a defect, the defect is fixed, the corpus is
re-run, and the two numbers go side by side*. s59 completed a second turn and moved nothing.
s60 fixed what s59's run named — **and the turn is only half done until the corpus runs.**

## NEXT ACTIONS

1. **Re-run the corpus. This is the whole point, and it is unfinished work, not a new task.**
   `adr/008` is expected to take `good-docs-overview-note` to a commit; if it does not, say so
   plainly and find the layer the failure moved to (that pattern has now held three sessions
   running). Pre-flight BY EXACT NAME — gotcha 89 — and launch DETACHED.
2. **Fix the measuring instrument as ONE pass.** **#141** (an intermittent decomposition-shape
   failure makes runs non-comparable) and **#136** (a multi-task case scored off the wrong
   record) are defects in the ruler, and s59 was distorted by both. **#131** (escalations not
   purged between cases) and **#132**/**#135** (manual pre-run steps) ride along.
3. **#138 — make the harness legible.** The operator can no longer tell what the harness does
   or why. `contract.docPaths` shipped with its UI row and `adr/008` extended that row;
   everything from `adr/006` onward did not. Start with the "what does this project actually
   guarantee" screen.
4. **#124** (a `broken` verdict naming no defect — capture `broken_contracts` next time) ·
   **#125** (`critic_total` tokens always 0).
5. **#129** — one provider is both the review gate and the harness's own critic.
6. **#133** (`readBoundedFileText` accepts a short read as a whole file) · **#122** (board
   auto-add, board-UI only, so it is the operator's).

`FUTURE-BACKLOG` is FROZEN; open items are GitHub issues on board #2.

## Open questions

- **Does a second critic need operator consent to take over?** (#129) A silent automatic
  fallback changes the acceptance bar without anyone saying so — but a fallback that waits for
  a human is not a fallback at 3am.
- **How should a multi-task case be scored?** (#136) The decisive-record rule is part of the
  oracle, so it is the operator's call, not a fix.
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
  paths, so Phase 2 protects them only via `constitutionPaths`.
- **Should one declaration buy two exemptions?** `contract.docPaths` was introduced for the
  critic's mandate (`adr/007`); `adr/008` (b) reuses it to scope the machine gate. Shipped on
  the operator's decision, and named here because a field's blast radius growing after it was
  blessed is exactly the drift `adr/006` exists to prevent.

## Recent sessions (full detail → `SESSION-LOG.md`)

> One line each — pointers, not summaries. Detail belongs in `SESSION-LOG.md`.

- **s60** — **`adr/008` MERGED** (PR #142, closes #140, CI 4/4, **9** gate rounds, R9 SAFE): a contract zone’s `path_globs` is its SCOPE, and a declared `contract.docPaths` path is outside zone checking — documenting a contract value no longer counts as changing it. The gate found **ten** defects, all on “which files did this diff touch”, **none caught by the feature’s own tests**; two were blockers of one class (a strict parser checking LESS than the sloppy reader it replaced, letting a diff naming a contract value reach COMMIT), now closed structurally. Two findings resolved by measurement, not code, and named in the ADR. Session resumed from repo state after the terminal was closed. New: gotcha 91. **Corpus NOT re-run — the metric is unmeasured.**
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
