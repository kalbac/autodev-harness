# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-02 (s09 — **P1 real-world DoD REACHED**: live build-step-9 on real repo `aurora` → green COMMIT with live claude+codex, oracle-equivalent. 2 harness fixes found+fixed live (worker-report harvest, Windows .cmd spawn), PR #16 merged to `main` (`d137f2b`), all 4 CI cells green; 272 tests).

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
| **P1 — Core loop (headless TS daemon)** | ✅ **DONE (s09).** Behavioral parity with the PS oracle on the fixture (18-scenario parity harness) AND one live real-repo workload (aurora → green COMMIT, live claude+codex) + CI green cross-platform. 272 tests. |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s09, 2026-07-02)

- **P1 real-world DoD reached.** Live build-step-9 on `aurora` (disposable Laravel sandbox in `d:/projects/`):
  CLAIM→worktree→live claude(sonnet)→harvest→fence→live codex(`clean`)→gate `php -l`→**COMMIT `3ffe028`**→done —
  oracle-equivalent. 2 harness bugs found live, both codex-gated + re-critic, merged (**PR #16 `d137f2b`**, 4 CI green).
- **Fix #4 `ded192e`** — `harvestWorkerReport` (`src/worker/report.ts`): worker writes `worker-report.md` into
  the worktree → dirty-file fence flagged it stray → relocate to runtimeDir before status-read+fence.
- **Fix #5 `76e0ab3`** — `runNative` via `cross-spawn`: node can't spawn the Windows `codex.cmd` shim (ENOENT).
- Step-0 tails done (PR #15): `[node/stdin-epipe]` gotcha + Supermemory. Gotchas 12→15 (worker-report, win-cmd-spawn, real-repo-run).

## NEXT ACTIONS (s10)

1. **🟡 Resolve `adr/003` open questions with the operator BEFORE building the orchestrator layer:**
   orchestrator↔conductor boundary, planner scope, config schema (role registry + per-adapter config).
   The deterministic conductor is done; the LLM-orchestrator is the next architectural piece and needs sign-off.
2. **Optional P1 hardening — Finding #1 (deps-provisioning):** a harness feature to symlink/junction configured
   dirs (`vendor/`, `node_modules/`, `.env`, sqlite) into each worktree before the gate, so gates can graduate
   from `php -l` to real test suites (`php artisan test`). Not a P1 blocker. codex-gated.
3. **Then P2** (localhost dashboard over the read-only `api` seam) / P3.

**Assets:** all P1 modules under `src/{util,config,blackboard,scheduler,worktree,router,worker,critic,watchdog,
escalate,anti-drift,gate,conductor,api}/` + `src/index.ts` (composition root). Parity harness under
`test/parity/`. CI at `.github/workflows/ci.yml`; asset copy at `scripts/copy-assets.mjs`. The loop runs
end-to-end and is behavior-pinned to the PS oracle on the fixture. Known deferred limits: gotcha
`[conductor/wiring]`.

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
- ✅ **RESOLVED (s09).** Live P1 parity target = `aurora` (disposable Laravel sandbox in `d:/projects/`,
  operator-designated as abandoned/deletion-candidate → free to use). Green COMMIT proven end-to-end.
- Repo hosting/licensing details for `kalbac/autodev-harness`.
- Exact per-project config file format (`.autodev/config.yaml` vs `harness.config.*`).

## Related
- `adr/002-build-own-harness-not-fork-ao.md` — the pivot (supersedes `adr/001`).
- `superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — P1 design.
- `superpowers/donor-extraction/decision-matrix.md` — the verified basis.
