# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (leaving s50)

A working **Node daemon + web dashboard**. The core loop (P1) and dashboard (P2) are
shipped; the attended **live-orchestrator presence** (chat as the project's main
screen) is shipped; the **unattended-autonomy half** of `adr/004` is partly built (2 of
~5 slices).

**s50 closed the `adr/006` enforcement tail — Phase 2, executable-input protected
paths.** Phase 1 (s49) stopped a worker from changing *what the gate checks*; Phase 2
stops it from editing the oracle *inputs the gate executes* — guard test files, mutation
recipes, agent-ci workflow files, and operator-declared human-only paths. The set is
declared at the trusted root and fenced by fingerprint **before the critic** (an oracle
touch now costs no critic tokens) and **before the stray/forbidden fence** (so the
reason is "the worker edited the oracle", not a generic "out of scope"). Literals are
fingerprinted directly on disk, which is what covers **git-ignored** oracle files the
porcelain fence cannot see. Six codex `gpt-5.6-luna` rounds; live-proven both
directions. With Phase 1+2 landed, the Authority-Model prerequisite the profiles thrust
depends on is **materially satisfied** — Phase 3 folds into Profiles itself.

## Phase status

| Area | Status |
|---|---|
| Core loop (P1, headless) | ✅ shipped, parity-proven against the PS oracle |
| Web dashboard (P2) | ✅ product-track items 1–4 done; general polish ongoing |
| Attended live-orchestrator presence (`adr/004`) | ✅ shipped (s40, PR #72) |
| Unattended autonomy (`adr/004`) | 🚧 partly built — see below |
| Critic model | ✅ codex `gpt-5.6-luna` (calibrated s44; **pin it**) |
| Authority Model (`adr/006`) | ✅ Phase 1 (s49) + Phase 2 (s50) shipped; Phase 3 folds into Profiles |

**Unattended-autonomy half (`adr/004`) — built vs remaining:**
- ✅ Slice 1 — overnight escalation supervisor (deterministic reason-routing, s45)
- ✅ Slice 2 — overnight presence toggle (global presence × per-project opt-in, s46)
- ⬜ Morning report (batch-narrate `.autodev/decision-journal.ndjson`, reuses the s40 narrator)
- ⬜ Per-project **north-star** concept doc (onboarding-created anti-drift anchor)
- ⬜ Mandatory anti-drift critic (intent vs cumulative diff)

## What s50 delivered (`adr/006` Phase 2 — executable-input protected paths)

- **`src/gate/oracle-paths.ts`** — `resolveOracleSet(cfg, raw, repoRoot)` builds the
  protected set from the **trusted root**: `contract.invariantsFile`/`guardsFile`,
  **every** GUARDS.md row's `recipe` + `guard_test` (all rows, not only
  mutation-verified — an unverified row's test file is still an oracle input), the
  `gate.agentCi.workflows` files + `.github/workflows/**` when agent-ci is enabled, and
  `contract.constitutionPaths`. `recipe.file` is deliberately **not** protected: it is
  the code under test, and protecting it would make every guarded zone's own source
  unwritable.
- **Two arms, different guarantees, not conflated.** `literals` are fingerprinted
  directly on the filesystem pre/post worker — this is what covers a **git-ignored**
  oracle file (audit SOUND #3 scope); every *derived* entry is a literal, so the
  concrete hole is closed. `globs` match the git-visible touched set only; a gitignored
  path matching *only* an operator glob is a documented residual (needs a bounded,
  junction-safe worktree walk → `FUTURE-BACKLOG.md`).
- **Fenced early.** Runs before the critic (no critic tokens burned on an oracle touch)
  and before the stray/forbidden fence (specific reason beats "out of scope").
  Escalates the existing `constitution` type — already non-retryable in the overnight
  supervisor, so no new plumbing through the journal/UI/reply path.
- **Six codex `gpt-5.6-luna` rounds**, each closing a narrower fail-open inside the
  previous round's own fix (absolute entries `join`ing to nonsense paths · a swallowed
  containment error · a bare `catch` folding EACCES into "absent" · an empty-string key
  `snapshot` skips · host-only absolute detection missing Windows forms on POSIX ·
  separator folding applied to only one of the two probe paths). Verdict CLEAN at round
  six. One invariant took five rounds to state properly: *every entry is
  worktree-relative, `/`-separated, and names a real regular file*. GOTCHAS 72→73.
- **Live-proven both directions** on `woodev-shipping-plugin-test`: a task whose
  `file_set` held `.github/workflows/ci.yml` escalated `constitution` with oracle
  evidence and never reached the critic (no `critic-verdict.json` written); a control
  task on a non-oracle file passed the fence, critic and gate and **committed**
  (`dd79ef4`). The live run also caught a reporting defect unit tests could not — a file
  matched by both arms read as "modified 2 oracle artifact(s)" for one edit (fixed:
  `mergeOracleHits`).
- **Still open by design:** `success_command`/`checkCommand` *implementations* are
  commands, not declared paths, so they are protected only if the operator lists them in
  `constitutionPaths`. Deriving paths from a command string is not reliably decidable.

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
- **Profiles / Qualification Layer** — a reusable per-project-type proof pack (WP/WC
  first): the harness proves the *process*, the profile proves the *product*. Our
  `gate.agentCi` is the substrate; a profile productizes it. (The `adr/004` **north-star**
  doc likely folds into this.)

## NEXT ACTIONS

- **(priority) Profiles / WP-WC Qualification Layer:** brainstorm→spec→build. The
  Authority-Model prerequisite is now satisfied (Phase 1+2 shipped). Fold in the
  `adr/004` north-star concept; `adr/006` Phase 3 lands here (the profile and its
  protected-path declaration must live at a trusted, worker-unwritable root, or the
  model is self-authorizing).
- *(done s50)* Docs audit — the divisible-by-10 checkpoint ran after the Phase-2 work:
  11 findings fixed (stale ADR-003 status · `AGENT-RULES` merge rule contradicting the
  s49 reconciliation · audit hole-count · Aider listed as unanalyzed · `PRINCIPLES.md`
  read-trigger · abandoned tag namespaces · `reference/` status banner · a broken
  markdown table · Russian-quote carve-out · `superpowers/` missing from navigation ·
  this file's own accumulated history). Next checkpoint: s60.
- **Remaining `adr/004` slices** (each own brainstorm→spec→plan): morning report ·
  mandatory anti-drift · (north-star → folded into profiles).
- **Metrics / Evaluation Corpus** (GPT suggestion, decide if/when): autonomy-%,
  rework-cycles, first-pass gate-success, critic FP/FN — the numbers that prove the gate.
  "Oracle-tamper attempts caught" is now a real, measurable gate property.
- **Carried:** agent-ci synthetic `GITHUB_REPO` for non-GitHub repos · overloaded
  `blocked` EscalationType (v1 parks all) · chat-runtime → TanStack AI + AG-UI (`FUTURE-BACKLOG`).

## Open questions

- **Oracle protection for `success_command`/`checkCommand` implementations** — they are
  commands, not declared paths, so Phase 2 protects them only when the operator lists
  them in `constitutionPaths`. Deriving a path set from a command string is not reliably
  decidable; is an explicit per-command path declaration worth the config surface?
- *(closed s50)* `adr/006` Phase 2 → shipped. Phase 3 → confirmed as a Profiles facet,
  not a standalone phase.
- *(closed s49)* s45 PR status → PR #76 merged 17.07. Merge policy → reconciled in `AGENTS.md`.

## Recent sessions (full detail → `SESSION-LOG.md`)

> One line each — pointers, not summaries. Detail belongs in `SESSION-LOG.md`.

- **s50** — `adr/006` Phase 2: protected-oracle-path fence (PR #79, open).
- **s49** — `adr/006` Phase 1: trusted-root oracle definitions (`cc0db6f`).
- **s48** — Authority Model audit + `adr/006` + `PRINCIPLES.md` #14/#15 (`c6c2343`).
- **s47** — docs consolidation + external review → the Profiles thrust (`7759346`).
- **s46** — overnight presence toggle, `adr/004` slice 2 (`680b9fa`).
- **s45** — overnight escalation supervisor, `adr/004` slice 1 (PR #76).
- **s44** — `gpt-5.6-luna` promoted as critic + reply-B poison fix.
- **s43** — reply-B cycle live-proven + `blocked` state (PR #74).
- **s42** — `adr/005` critic-is-a-correctness-gate (PR #73).
- **s41** — first real CI run on a real task, end-to-end DONE (`3609a2c`).
- **s40** — attended live-orchestrator presence, chat = main screen (PR #72).

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
