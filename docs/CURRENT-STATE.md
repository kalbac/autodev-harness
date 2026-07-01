# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (s06 — watchdog/escalate/anti-drift/fingerprint Tasks 20–23; 193 tests green, merged to main).

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
| **P1 — Core loop (headless TS daemon)** | 🔨 **in progress — steps 1–6 done (gate group + watchdog/escalate/anti-drift/fingerprint Tasks 20–23); 193 tests green. Next: step 7 conductor wiring (Tasks 24–26)** |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s06, 2026-07-01)

- **Step 6 Tasks 20–23** — `watchdog/watchdog.ts` (real `runWatched`, cross-platform tree-kill, makes the
  `runner.ts` seam real + optional `pollMs`), `escalate/escalate.ts` (artifact + Telegram/outbox, never-throws),
  `anti-drift/anti-drift.ts` (configurable intent + injected model → one digest line), `util/fingerprint.ts`
  (content-keyed SHA256 fence, divergence #3). 4 modules dispatched in parallel (sonnet-5, TDD). **193 tests green.**
- **Codex gate:** 4 findings → 3 accepted (anti-drift model-throw fail-hard; `forbiddenTouches` raw-path fail-open;
  `escalate` env/log unguarded vs never-throws), 1 rejected as anti-parity (multiline `/im` verdict = verbatim
  `anti-drift.ps1:91`). **Re-critic** refuted the F1 fix as incomplete → `safeLog` everywhere in `runAntiDrift`.
  New gotcha `[ts/fail-closed]`: guard catch-block logging in never-throws modules.

## NEXT ACTIONS (s07)

1. **Build step 7 — `conductor` wiring (Tasks 24–26)**, same discipline. This is pure wiring + judgment routing,
   zero LLM calls; composes every seam built so far. Parity: `conductor.ps1` §2 exact step sequence.
   - Task 24: branch preflight + `Invoke-ConductorIteration` spine (CLAIM → circuit-breaker → worker → report
     routing → dirty-file fence → diff+critic bounded retry → gate → decision, with divergences #4/#8/#10).
   - Task 25: outer loop (`MaxSessionHours` graceful exit #9; anti-drift every N commits via explicit
     `iterationCommitted` flag; rate-limit backoff via `iterationRateLimited` flag; `--once`/`--maxIterations`).
   - Task 26: port the 8 conductor `-SelfTest` cases (all pure, fakes for worker/critic/gate).
2. Then thin `api` (27) → parity harness + CI (28–29). Plan: `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md`.
3. **🟡 Before building the orchestrator layer:** resolve `adr/003` open questions (orchestrator↔conductor
   boundary, role registry) with the operator — but the deterministic conductor (Tasks 24–26) can land first.
4. **Pick the live woodev-class parity target** (operator) — needed only at build step 9 (DoD).

**Assets:** modules under `src/{util,config,blackboard,worktree,router,worker,critic,watchdog,escalate,anti-drift,gate}/`.
Decision + support layers all live: `gate/*` (all I/O via `GateDeps`), `watchdog/watchdog` (real, seam wired),
`escalate/escalate`, `anti-drift/anti-drift`, `util/fingerprint`. **Still missing: `conductor` (Task 24) — the loop
that wires them end-to-end — and thin `api` (27).** `src/index.ts` is still a stub awaiting `conductor`.

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
