# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (s08 — thin api + parity harness + cross-platform CI Tasks 27–29 + EPIPE fix; **P1 DoD fixture-side reached, PR #13 merged to `main`, all 4 CI cells green**; 265 tests green).

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
| **P1 — Core loop (headless TS daemon)** | 🔨 **build steps 1–9 done (Tasks 1–29): loop runs end-to-end + thin api + parity harness + cross-platform CI; 264 tests green, typecheck (src+test) clean. Fixture-side DoD reached. Remaining: build step 9 live woodev workload (operator-picked) = real-world DoD** |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s08, 2026-07-01)

- **Tasks 27–29 done → P1 fixture-side DoD.** Task 27 `src/api/server.ts` (thin http+ws over the repo:
  `/state`, WS change-stream, structured A/B `/escalations/:id/reply`). Task 28 `test/parity/parity.test.ts`
  (18-scenario parity harness: real conductor+repo+scheduler+escalate, fake worker/critic/worktree/git, same
  decisions + queue/escalation end-state as the PS oracle). Task 29 GH Actions matrix (win+linux × node 20/22)
  + `postbuild` schema copy + `tsconfig.typecheck.json`. **264 tests green, typecheck (src+test) clean.** PR
  `feat/p1-dod-api-parity-ci` (3 commits) **awaiting operator merge**.
- **Three codex gates + two re-critics.** api: 3 accepted (body cap+413, id allowlist, bounded digest tail);
  re-critic caught an over-broad partial-line drop. parity: 8 accepted incl. one "passes for the wrong reason";
  re-critic caught 2 vacuous label assertions. New gotchas `[ts/typecheck-scope]`, `[api/413-teardown]`,
  `[test/vacuous-assert]`.
- **CI flake found+fixed:** first cross-platform run went red on ubuntu/node20 — real EPIPE race in
  `src/util/native.ts` (`child.stdin` write with no `'error'` listener). Fixed at root + regression test
  (`790ffc9`); re-run → **all 4 cells green**. PR **#13 merged to `main`** (`cde17a2`).

## NEXT ACTIONS (s09)

0. **Deferred tails from s08 (quick):** write the `[node/stdin-epipe]` gotcha file (+ index in GOTCHAS.md,
   bump count 11→12); save 1–2 cross-project TS/Node learnings (`[ts/typecheck-scope]`, EPIPE) to Supermemory.
1. **Build step 9 — live woodev workload (real-world P1 DoD):** operator picks ONE live woodev-class task; run
   it through the harness end-to-end (real claude worker + codex critic) and confirm parity with how the PS
   loop would handle it. This is the last P1 gate. NOTE first-live-run risks: `[conductor/wiring]` deferred
   limits (whitespace-split gate commands, main-root invariants) may bite real recipes.
2. **🟡 Before the orchestrator layer:** resolve `adr/003` open questions with the operator (deterministic
   conductor already landed). Then P2 (web UI over the `api` seam) / P3.

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
- Which live woodev-class workload to use as the P1 parity target (operator; needed at DoD step 9).
- Repo hosting/licensing details for `kalbac/autodev-harness`.
- Exact per-project config file format (`.autodev/config.yaml` vs `harness.config.*`).

## Related
- `adr/002-build-own-harness-not-fork-ao.md` — the pivot (supersedes `adr/001`).
- `superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — P1 design.
- `superpowers/donor-extraction/decision-matrix.md` — the verified basis.
