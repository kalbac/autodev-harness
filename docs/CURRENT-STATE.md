# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (s05 — gate group Tasks 15–19; 155 tests green, merged to main).

## Direction (as of s02 — see `adr/002`)

**Not forking AO.** Building our **own Node LTS + TypeScript harness** = headless
daemon (a TS port of our proven autodev-loop) + local web UI, **file-blackboard as the
single source of truth**, assembling the verified best-of from four donors. Skeleton is
**frozen** (6 axes, codex-verified). Mission/discipline unchanged.

## Phase

| Phase | Status |
|---|---|
| P0 — Bootstrap docs & charter | ✅ done (s01) |
| Pivot — build-own vs fork; donor extraction; freeze skeleton | ✅ done (s02, `adr/002`) |
| **P1 — Core loop (headless TS daemon)** | 🔨 **in progress — steps 1–5 done (gate group Tasks 15–19 = correctness core); 155 tests green; PRs #1/#3/#5/#9/#10 merged. Next: step 6 watchdog/escalate/anti-drift** |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s05, 2026-07-01)

- **Gate group Tasks 15–19** (PR #10) — the correctness core. `src/gate/{invariants,guards,mutation-check,gate}.ts`
  + `self-test.test.ts` (5 `gate.ps1 -SelfTest` cases). Per-VALUE coverage (divergence #2) verified. Three leaf
  modules dispatched in parallel (sonnet-5, TDD); gate.ts = exact port of `Invoke-AutodevGate`. **155 tests green.**
- **🔴 guards/recipe question RESOLVED → (b)** from real `.autodev/` data (see Open questions, now closed).
- **Whole-module codex gate:** correctness core confirmed clean; 3 dependency-resilience findings all rejected
  as anti-parity (PS loads guards before check; `!range` guard is verbatim `gate.ps1:149`; broken constitution
  → conductor fail-closes, not RETRY). Throw/fail-closed contract documented in `runGate`.
- **Merged (self-merge, operator-confirmed):** PR #10 + PR #9 (batch-rule) → `main`.

## NEXT ACTIONS (s06)

1. **Build step 6 — `watchdog` + `escalate` + `anti-drift` + fingerprint fence (Tasks 20–23)**, same discipline.
   - Task 20 `watchdog/watchdog.ts`: `runWatched` liveness (stream + heartbeat + activityPaths mtime), cross-platform
     tree-kill (Win `taskkill /T`; POSIX pgroup) — the injected `runner` seam becomes real. Parity `watchdog.ps1`.
   - Task 21 `escalate/escalate.ts`: write `escalations/<id>.md` + type enum + Telegram-or-outbox delivery.
   - Task 22 `anti-drift/anti-drift.ts`: intent-vs-diff sonnet check → one digest line; unparseable→UNCERTAIN.
   - Task 23 `util/fingerprint.ts`: SHA256 content fingerprints (divergence #3, content-keyed not path-set).
2. Then step 7 `conductor` (24–26) → thin `api` (27) → parity harness + CI (28–29).
   Plan: `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md`.
3. **Pick the live woodev-class parity target** (operator) — needed only at build step 9 (DoD).
4. **Definition of done for P1:** behavioral parity with the PS loop on a fixture + that live workload.

**Assets:** modules under `src/{util,config,blackboard,worktree,router,worker,critic,watchdog,gate}/`.
`gate/{invariants,guards,mutation-check,gate}` live (decision core, all I/O via injected `GateDeps`).
`watchdog/runner` is still just the seam — real `watchdog` impl is Task 20. `src/index.ts` still a stub
awaiting `conductor` wiring (Task 24). NO watchdog impl, NO conductor/escalate/anti-drift/api yet.

## Continuity (do not break)

The **existing PowerShell autodev-loop** (`D:/Projects/woodev_framework/tools/autodev/*.ps1`)
keeps running our real tasks until P1 reaches parity. It is the **parity oracle** — untouched.

## Assets on disk

- `references/` — 5 donor clones (git-ignored; URLs + pinned SHAs in `references/MANIFEST.md`).
  Note gotcha: OpenHands real code is in `references/software-agent-sdk/`.
- `docs/superpowers/donor-extraction/` — 5 briefs, `decision-matrix.md` (VERIFIED),
  `codex-verification.md`, `autodev-loop-parity-spec.md`.
- `docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — the P1 design.

## Open questions

- 🟡 **Role model = configurable matrix (see `adr/003`, proposed):** roles (orchestrator, worker,
  critic, planner, …) map to models via global defaults + per-project overrides; no vendor bound to
  a role; operator talks to an in-harness LLM **orchestrator** that drives the run while the
  **gate/enforcement stays deterministic**. Current claude/codex adapters are valid MVP role-impls.
  Generalization (role registry + per-adapter config + heterogeneity-as-policy) lands at the
  config/conductor stage. `adr/003` open questions (orchestrator↔conductor boundary, planner scope,
  config schema) to resolve with the operator before building the orchestrator layer.
- ✅ **RESOLVED (s05) → (b).** Gate/recipe design: confirmed from real `.autodev/GUARDS.md` + recipe files
  that the table's `contract_value` cell is human-facing (can list `+`-joined siblings; yandex row lists two
  values but the recipe carries one `canonical_value`) while the machine per-value key is `recipe.canonical_value`,
  and `zone_id` lives ONLY in the recipe. `guards.ts` = pure fs-free table parser + selectors over enriched
  `GuardRecipePair[]`; `gate.ts` owns recipe loading (mirrors PS `Get-AutodevGuards` + `Get-AutodevGuardRecipePairs`
  + pure `Select-*`). Matching the raw `contract_value` cell would have falsely covered a sibling value —
  (b) is required for divergence-#2 correctness, not just cleaner.
- Which live woodev-class workload to use as the P1 parity target (operator; needed at DoD step 9).
- Repo hosting/licensing details for `kalbac/autodev-harness`.
- Exact per-project config file format (`.autodev/config.yaml` vs `harness.config.*`).

## Related
- `adr/002-build-own-harness-not-fork-ao.md` — the pivot (supersedes `adr/001`).
- `superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — P1 design.
- `superpowers/donor-extraction/decision-matrix.md` — the verified basis.
