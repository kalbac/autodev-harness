# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (s04 — worker claude-adapter + full critic module; 101 tests green).

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
| **P1 — Core loop (headless TS daemon)** | 🔨 **in progress — steps 1–3 done + step 4 done (worker claude-adapter + full critic module); 101 tests green; PRs #1/#3/#5 merged. Next: step 5 gate group** |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s04, 2026-07-01)

- **Task 11 `worker/claude-adapter`** (PR #3) + **Tasks 12–14 full `critic` module** (PR #5) — same discipline
  (sonnet-5 implementer → spec-check → codex GPT-5.5 gate → fix + re-critic). 101 tests green, typecheck clean.
- Operator rules → `AGENTS.md` + memory: **Russian to operator / English artifacts**; **agent always does
  merges/commits/PRs**; **per-module PRs** for the rest of P1. PR #4 landed AGENTS.md.
- Whole-module critic gate caught a **High** stale-`-o`-outfile bug the subagent's own codex pass missed → fixed + re-critic clean.

## NEXT ACTIONS (s05)

1. **Build step 5 — `gate` group (Tasks 15–19)**, same discipline. This is the **correctness core**
   (per-VALUE coverage, divergence #2). Order: `invariants.ts` (Task 15) → `guards.ts` (Task 16) →
   `mutation-check.ts` (Task 17) → `gate.ts` decision core (Task 18) → port the 5 `gate.ps1 -SelfTest`
   cases, esp. case 2 sibling-value-uncovered (Task 19). Parity oracle: spec **§4** + **§3** (INVARIANTS
   block, GUARDS 7-col table). ⚠️ **Resolve the guards/recipe design question below BEFORE dispatching Task 16.**
2. Then step 6 (`watchdog`+`escalate`+`anti-drift`, Tasks 20–23) → step 7 `conductor` (24–26) → thin `api`
   (27) → parity harness + CI (28–29). Plan: `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md`.
3. **Pick the live woodev-class parity target** (operator) — needed only at build step 9 (DoD).
4. **Definition of done for P1:** behavioral parity with the PS loop on a fixture + that live workload.

**Assets:** modules under `src/{util,config,blackboard,worktree,router,worker,critic,watchdog}/`. `worker/claude-adapter`
+ `watchdog/runner` (seam) live; `critic/{verdict,fencing,prompt,codex-adapter}` + schema live. `src/index.ts`
still a stub awaiting `conductor` wiring (plan Task 24). NO watchdog impl yet (Task 20), NO gate/conductor yet.

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
- 🔴 **Gate/recipe resolution (settle before Task 16 `guards.ts`):** parity §4 selects guards by
  `recipe.canonical_value` (per-value) and `recipe.zone_id` (zone-fallback), but the `GUARDS.md` 7-col
  table only carries `contract_id | contract_value | ...` — no `zone_id`, and the recipe fields live in a
  separate `mutation-recipe.json` referenced by the table's `recipe` column. **Decide:** (a) `guards.ts`
  loads each row's recipe file to expose `canonical_value`/`zone_id` (couples the parser to the fs), or
  (b) treat the table's `contract_value` as the canonical value and have `gate.ts`/`mutation-check` own
  recipe loading + `zone_id` resolution, passing enriched guards in. Leaning (b) for a pure table parser,
  but confirm against real `GUARDS.md`/recipe examples in `D:/Projects/woodev_framework/.autodev/` first.
- Which live woodev-class workload to use as the P1 parity target (operator; needed at DoD step 9).
- Repo hosting/licensing details for `kalbac/autodev-harness`.
- Exact per-project config file format (`.autodev/config.yaml` vs `harness.config.*`).

## Related
- `adr/002-build-own-harness-not-fork-ao.md` — the pivot (supersedes `adr/001`).
- `superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — P1 design.
- `superpowers/donor-extraction/decision-matrix.md` — the verified basis.
