# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (s07 — scheduler + conductor + composition root Tasks 23.5/24–26; step 7 done; 233 tests green; PR feat/conductor-p1 awaiting operator merge).

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
| **P1 — Core loop (headless TS daemon)** | 🔨 **in progress — steps 1–7 done (conductor loop + scheduler + composition root Tasks 23.5/24–26 wired; loop runs end-to-end); 233 tests green. Next: thin `api` (Task 27) → parity harness + CI (28–29) = P1 DoD** |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s07, 2026-07-01)

- **Step 7 done** — Task 23.5 `scheduler/scheduler.ts` (plan gap; `scheduler.ps1` parity), Tasks 24–26
  `conductor/conductor.ts` (full parity §2 spine + outer loop, DI, 8 self-tests on fakes), and the step-7
  close-out: `src/index.ts` production composition root + `src/util/log.ts`, plus worktree `create()`
  re-queue safety. **233 tests green, typecheck clean.** PR `feat/conductor-p1` **awaiting operator merge**.
- **Two codex gates + two re-critics.** Conductor/scheduler: 2 rejected as faithful-to-oracle, 3 accepted;
  re-critic caught an incomplete teardown fix (`safeLog`). Integration: 2 deferred w/ docs, 4 fixed; re-critic
  caught `--max-iterations` missing-value. New gotchas `[ts/test-hang]`, `[conductor/wiring]`.

## NEXT ACTIONS (s08)

1. **Merge `feat/conductor-p1`** first (operator-approved `gh pr merge` — classifier blocks self-authored).
2. **Task 27 — thin `api/server.ts`:** `http` + `ws` over `BlackboardRepository` — `GET /state` (queues +
   digest tail), WS change-stream via `chokidar` on `.autodev/`, `POST /escalations/:id/reply` (A/B structured;
   free text recorded, NEVER fed to a worker — injection surface). Plan §Task 27.
3. **Tasks 28–29 — parity harness + cross-platform CI** = P1 DoD (fixture side). Task 28: seeded fixture repo
   (normal / contract-zone / TOO_BIG / poison / 429) run through the loop with fake adapters, assert same
   COMMIT/ESCALATE/RETRY + done/escalations end-state as the PS loop. Task 29: GH Actions matrix (win+linux,
   node 20/22): `npm ci` → `typecheck` → `test`. NOTE also copy `critic-verdict.schema.json` into `dist/`
   (deferred `[critic/codex]` gotcha).
4. **🟡 Before the orchestrator layer:** resolve `adr/003` open questions with the operator (deterministic
   conductor already landed). **Pick the live woodev-class parity target** (operator; needed at build step 9).

**Assets:** all P1 core modules live under `src/{util,config,blackboard,scheduler,worktree,router,worker,critic,
watchdog,escalate,anti-drift,gate,conductor}/` + `src/index.ts` (composition root) + `src/util/log.ts`. **The
loop runs end-to-end** (index.ts wires every real dep → `createConductor().run()`). Still missing: thin `api`
(27) + parity harness/CI (28–29). Known deferred limits: see gotcha `[conductor/wiring]`.

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
