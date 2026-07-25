# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s55)

A working **Node daemon + web dashboard**. P1 core loop + P2 dashboard shipped; attended
live-orchestrator presence shipped; the **unattended-autonomy half** of `adr/004` COMPLETE
and merged (s54). `main` is at **`510617f`**. s55 was a tail-clearing + capstone-start
session: **four PRs merged** — the whole architecture-review chain is now shipped except the
Evaluation Corpus's *Phase 2* (real executor + authored cases + live run).

**s55 shipped (all merged to `main`):**
- **PR #118** — the s54 session-save docs (a tail: its PR was never opened in s54 due to a
  GitHub API outage; opened + merged first thing s55).
- **PR #119 — tech-debt #85 + #106** (both issues closed):
  - **#85** — de-flaked the wall-clock-dependent watchdog tests. Extracted a pure
    `classifyWatchTick` (timing decision on plain numbers) + a `RunWatchedDeps` seam
    (`now`/`spawn`); two deterministic wiring tests drive a fake child + injected clock,
    **mutation-verified**. `server.test.ts`: 9 fixed-delay `tick()` waits → polled
    `vi.waitFor`. codex R1 NOT SAFE (single-vs-double clock read; alive test vacuous at the
    strict-`>` boundary) → fixed → R2 SAFE.
  - **#106** — fail-closed when the critic provider is unavailable. `CriticResult.failure`
    (exit code + detail); the codex adapter folds a spawn-reject into a null-verdict result
    (no longer throws for a down provider); a new `EscalationType "critic-unavailable"`; the
    conductor now escalates a null-not-rate-limited verdict **immediately at round 0** (zero
    wasted worker rounds) instead of looping to maxRounds and mislabeling it `uncertain`.
    Above the gate, fail-closed. codex SAFE.
- **PR #120 — Evaluation Corpus, Phase 1 (deterministic machinery)** — the last link of the
  `architecture-review-external-2026-07.md` chain. Five pure modules in `src/eval/`:
  `corpus-case` (fail-closed schema: seed + intent + expected outcome + an `adversarial`
  flag), `corpus-metrics` (pure aggregator → first-pass rate, **escaped-defect rate** over
  adversarial cases only, escalations-by-type, wall-clock, token counts — never $),
  `corpus-report` (metrics→markdown), `corpus-runner` (`runCorpus` drives cases through an
  injected `CaseExecutor` sequentially; a throwing case → null evidence, not an abort),
  `corpus-loader` (fail-closed `*.json` case loading). codex R1 NOT SAFE (escaped-defect
  conflated adversarial vs ambiguous; unescaped markdown cells) → fixed → R2 SAFE; runner +
  loader SAFE. 31 eval tests.

Also: removed a mis-filed card (autodev-harness #116 was on the Woodev Base-Theme board #5
as well as its own board #2 — a one-off wrong-board add; deleted from #5).

**Discipline held throughout:** every substantial change went TDD → independent codex
`gpt-5.6-luna` gate (pinned) → fix → re-gate; every merge on green CI 4/4. The operator was
emphatic this session about **not stopping to ask** — once a plan is set, execute the whole
chain to merge and report results, reserving questions for true product forks (see
`[[feedback-decide-dont-ask]]`, sharpened s55).

## Phase status

| Area | Status |
|---|---|
| Core loop (P1, headless) | ✅ shipped, parity-proven against the PS oracle |
| Web dashboard (P2) | ✅ product-track items 1–4 done; general polish ongoing |
| Attended live-orchestrator presence (`adr/004`) | ✅ shipped (s40, PR #72) |
| Unattended autonomy (`adr/004`) | ✅ COMPLETE (s54 shipped the last slice) — see below |
| Critic model | ✅ codex `gpt-5.6-luna` (calibrated s44; **pin it**) |
| Authority Model (`adr/006`) | ✅ Phase 1 (s49) + Phase 2 (s50) + Phase 3 (s51, via Profiles) shipped |
| Profiles / Qualification Layer | ✅ v1 shipped (s51) -- 2 facets (`gates` + `protectedPaths`), WP/WC first |
| Gate feedback on RETRY | ✅ shipped (s51) -- the worker now sees WHY the gate rejected it |
| Line-scoped profile gates | ✅ shipped (s51, `c1ff87e`) -- `wordpress-woocommerce@2`; the worker owns the lines it wrote |
| Two reports (Execution + Qualification) | ✅ shipped s52 (PR #113, `4fc1e87`, CI 4/4) -- per-task evidence ledger + both reports; 4 critic rounds -> SAFE |
| CRLF-vs-WPCS-on-Windows papercut | ✅ shipped s53 (PR #114, `2a0b326`, CI 4/4) -- `src/normalize/eol.ts`, `.gitattributes`-governed CRLF→LF; live-proven `fb21553` |
| Morning Report (3rd report type) | ✅ shipped s53 (PR #115, `d8badd4`, CI 4/4) -- narrate the decision journal, Principle-11 reconciled |
| Mandatory anti-drift + north-star | ✅ shipped + MERGED s54 (PR #117, `955e05b`, CI 4/4) — north-star preflight + halt-on-drift, above the gate; codex R1→fix→R2 SAFE; live-proven 3 ways. Closes the unattended-autonomy half of `adr/004`. |
| Tech-debt: flaky wall-clock tests (#85) | ✅ shipped s55 (PR #119) — pure `classifyWatchTick` + injected clock/spawn seam; mutation-verified deterministic wiring tests; `vi.waitFor` in server tests. codex R1→R2 SAFE. |
| Tech-debt: critic-unavailable (#106) | ✅ shipped s55 (PR #119) — `CriticResult.failure` + new `critic-unavailable` EscalationType; null-not-rate-limited verdict escalates at round 0 (no wasted worker rounds), fail-closed. codex SAFE. |
| Evaluation Corpus — Phase 1 (machinery) | ✅ shipped s55 (PR #120, `510617f`) — 5 pure modules in `src/eval/` (case schema, aggregator, report, runner, loader); 31 tests; codex R1→R2 SAFE. **Phase 2 = real executor + cases + live run → issue #121.** |

**Unattended-autonomy half (`adr/004`) — COMPLETE (all four slices shipped):**
- ✅ Slice 1 — overnight escalation supervisor (deterministic reason-routing, s45)
- ✅ Slice 2 — overnight presence toggle (global presence × per-project opt-in, s46)
- ✅ Morning report — narrate `.autodev/decision-journal.ndjson`, reconciled vs the live queue (s53, PR #115)
- ✅ Mandatory anti-drift + per-project **north-star** (`.autodev/GOAL.md`) — **shipped + MERGED s54** (PR #117, `955e05b`); the north-star IS the anti-drift intent anchor, and a silent one fails closed unattended while a DRIFT halts the overnight drain

## What s51 delivered (Profiles / WP-WC Qualification Layer v1)

- **A profile is an ORACLE SOURCE, not a second judge.** That was the load-bearing
  design call: because the profile *is* the oracle, the whole `adr/006` Phase 1+2
  protection is inherited for free. A parallel judge would have needed its own
  protection story, and a profile over an unprotected oracle is theater.
- **`src/profile/`** — a fail-closed loader. Unknown id, version mismatch, unknown key,
  id/directory disagreement, path traversal in the id, a whitespace install path, a
  ruleset the profile forgot to ship, an absolute path in a gate command, a profile
  directory that resolves outside the harness root: all throw at load. A profile that
  cannot be resolved exactly as pinned must stop the run, never degrade to "no profile"
  -- the degraded mode means gates the operator believes are running are not running,
  while a green verdict claims a qualification that never happened.
- **Gate step 1d**, mirroring `agentCi`'s step 1c. `GateVerdict` gains `profile_green`
  (deliberately its own field, never folded into `composer_green`, so a later Product
  Qualification Report assembles from already-separated data). Gates declare
  `redExitCodes`: exit 0 = pass, a declared code = worker-fixable RED -> RETRY, **any
  other non-zero = the tool could not do its job** -> throw -> the conductor escalates.
  Codes were MEASURED, not assumed (`composer validate` exits 3 with no manifest, 1 on a
  schema violation; PHPCS 1/2 are findings, 3 is a processing error).
- **The fifth oracle source.** A profile's `protectedPaths` go through the same
  `addLiteral`/`addGlob` helpers as `constitutionPaths`, inheriting Phase 2's
  fail-closed normalization verbatim.
- **`adr/006` Phase 3 landed here**, as predicted: the profile lives in the harness
  repo, which the worker's worktree never intersects, so it is worker-immutable by
  construction. s51 also made that claim *checked* rather than asserted -- a symlinked
  profile directory used to make the containment test vacuous (round-4 finding).
- **Gates are DIFF-SCOPED**, and this was found by measurement before shipping: the WPCS
  ruleset reports **7069** errors tree-wide and **8** on the file a task actually
  changed, so a whole-tree gate would be red on every run -- blocking everything while
  proving nothing about the diff. GOTCHAS 73 -> 75.
- **Six codex `gpt-5.6-luna` rounds**, the same convergence shape as Phase 1's four and
  Phase 2's six: R1 conflated RED with UNRUNNABLE; R2 found the fix still admitted
  `={profile}/...` ("ends with `=`" is not proof of a flag); R3 found `<dir>/../outside`
  still escaped and `<dir>-evil/x` passed as a bare path; R4 found the trust boundary
  asserted but never verified; R5 found an absolute path hiding after a *second* `=`.
  R6 found the R5 fix guarded only ONE side of the version comparison. Three findings
  were declined or downgraded with rationale verified against real code -- R6's own
  severity was cut after a test proved its exploit path unreachable.
- **All three live directions proven** on `woodev-shipping-plugin-test`:
  1. a new PHP file drew two genuine WPCS errors -> `profile_green:false`, `RETRY`;
  2. a docs task -> phpcs correctly **skipped** (logged), `profile_green:true`,
     **committed** (`35db1a4`);
  3. a task whose `file_set` held `phpcs.xml` -> `constitution` escalation naming the
     profile (`profile protectedPaths: phpcs.xml [fs-fingerprint]`), raised **before the
     critic** -- no `critic-verdict.json` written, no critic tokens spent.

## The thrust — Authority Model → Profiles (from the external review)

`wiki/architecture-review-external-2026-07.md` details it. The chain, order load-bearing:

```text
Authority Model  →  Profiles / Qualification Layer  →  two reports  →  Evaluation Corpus
```

- **Authority Model** — audited s48; formalized in `adr/006`; **Phase 1 shipped s49,
  Phase 2 shipped s50**. The prerequisite the profiles thrust depends on (a profile over
  an unprotected oracle is theater) is now materially satisfied; Phase 3 is not a
  separate step — it folds into Profiles (the profile and its protected-path declaration
  must themselves live at the trusted root).
- **Profiles / Qualification Layer** — **v1 shipped s51** (two facets: `gates` +
  `protectedPaths`; WP/WC first). Next in the chain — the **two reports** — is **built
  and live-proven in s52** (`feat/two-reports`), awaiting merge. (The `adr/004`
  **north-star** doc still folds into this.) After the reports land, the chain's last
  link is the **Evaluation Corpus**.

## NEXT ACTIONS

s55 cleared both open tech-debt items (#85, #106) and shipped **Evaluation Corpus Phase 1**
(the deterministic machinery). The architecture-review chain is now shipped end-to-end
except the Corpus's Phase 2. In priority order:

- **(NEXT, priority) Evaluation Corpus — Phase 2 (issue #121).** The capstone. Three parts:
  1. **Real `CaseExecutor`** — the technical piece (no operator input needed): wires
     seed-repo → compose run from `case.intent` → drive the headless conductor to a terminal
     → read the `EvidenceRecord` (via `loadEvidence`). Environment-bound (real git/worktrees/
     drain), the biggest single brick. Build it as a thin adapter over the existing daemon
     composition; keep the orchestration testable (the runner already injects the executor).
  2. **Authored cases** (operator product fork) — ~6-8 good + adversarial cases on the
     polygon + a couple synthetic. Bring a concrete proposed set, not a menu. Proposed pass
     bar: every case's actual outcome == expected, with **escaped-defect-rate == 0** the
     headline gate.
  3. **Live measurement run** — on-demand `eval` command (NOT in CI: real codex calls are
     costly/non-deterministic), operator-observable. The capstone proof.
- **PHPStan as a profile gate (#87)** — blocked on a portable way for a profile-shipped neon
  to reference an extension living in the project's `vendor`.
- **Carried:** overloaded `blocked` EscalationType (low value) · chat-runtime → TanStack AI +
  AG-UI (#91) · agent-ci synthetic `GITHUB_REPO`. `FUTURE-BACKLOG` is FROZEN; open items are
  GitHub issues.

## Open questions

- *(closed s51)* **Per-FILE vs per-LINE gate scoping** → line-scoping shipped. File-level
  made the gate *meaningful* (7069 → 8); line-level made it *usable* (a legacy file with
  10 pre-existing violations now commits a compliant change).
- **A profile gate's toolchain still comes from the project.** `vendor/bin/phpcs` is
  installed by the project's own `composer.json`, so a worker could in principle weaken
  the analyzer itself. Named residual, not closed: no mechanical rule separates "a project
  script" from "a project binary".
- **PHPStan in a profile.** Deliberately not a v1 gate: useful WordPress analysis needs
  `szepeviktor/phpstan-wordpress`, whose `extension.neon` a profile-shipped config cannot
  portably reference (a neon `includes:` resolves relative to the neon file, which lives
  in the harness repo where no project `vendor/` exists). Measured: without it, a correct
  file draws 14 phantom "unknown class/function" findings. Needs a way for a profile to
  inject a project-resolved autoload/extension path.
- **The analyzer toolchain is project-controlled.** A profile's gates run
  `vendor/bin/phpcs`, and `vendor` comes from the project's own `composer.json`. Named
  residual, not closed: no mechanical rule separates "a project script" from "a project
  binary", so pretending a check closes it would be worse than naming it.
- **Oracle protection for `success_command`/`checkCommand` implementations** — they are
  commands, not declared paths, so Phase 2 protects them only when the operator lists
  them in `constitutionPaths`. Deriving a path set from a command string is not reliably
  decidable; is an explicit per-command path declaration worth the config surface?
- *(closed s51)* `adr/006` Phase 3 → landed inside Profiles, as predicted.

## Recent sessions (full detail → `SESSION-LOG.md`)

> One line each — pointers, not summaries. Detail belongs in `SESSION-LOG.md`.

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

## Environment (verified s46)

- **Daemon:** `node dist/index.js serve` (:4319, daemon-global, serves `dist/ui`) or `node dist/index.js run` (headless, from the project dir). **Rebuild BOTH bundles** after backend changes (`npm run build` AND `npm run build:ui`).
- **Presence store:** `~/.autodev/settings.json` (`{overnight:{enabled}}`); `GET`/`PATCH /settings`. Per-project opt-in: `autonomy.overnight.enabled` in the project `.autodev/config.yaml`. Overnight runs on the AND, presence read fresh per trigger.
- **Test repo:** `woodev-shipping-plugin-test` (registry `~/.autodev/projects.json`, path `D:\Projects\wordpress\woodev-shipping-plugin-test`, on `autodev/main`). `.autodev` is git-excluded, so seeding never dirties the tree.
- **Critic:** codex via the `codex:codex-rescue` subagent — **pin `--model gpt-5.6-luna`**.

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `adr/004` — live-orchestrator presence + post-review autonomy (the doctrine driving the remaining slices).
- `FUTURE-BACKLOG.md` — deferred features / tech debt.
