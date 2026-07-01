# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (s02 — pivot + donor extraction + P1 spec).

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
| **P1 — Core loop (headless TS daemon)** | 📝 **spec written; NEXT = plan + implement** |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s02, 2026-07-01)

- Pivoted from "fork AO" to "build our own harness" (`adr/002`); AO → one of 4 donors.
- Ran donor-extraction: 5 Sonnet-5 agents → briefs; synthesized `decision-matrix.md`;
  **codex GPT-5.5 verified** the 🔴 claims (17/18 confirmed, 1 partial, none refuted).
- Resolved 6 skeleton axes with operator; froze architecture; wrote the **P1 design spec**.

## NEXT ACTIONS (new session — context was full, deliberately deferred)

1. **Create the remote repo** `github.com/kalbac/autodev-harness` and wire `origin`
   (does not exist yet). Decide licensing (donors are Apache-2.0/MIT).
2. **Run `superpowers:writing-plans`** on
   `docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` → implementation plan.
3. **Implement P1** per the spec's build order (§10): `config`+`blackboard` → `worktree`
   → `worker-runner`(claude)+`router` → `critic-runner`(codex) → `gate`+`guards`+`mutation`
   → `watchdog`+`escalate`+`anti-drift` → `conductor` → thin `api` → parity harness + CI.
4. **Definition of done for P1:** behavioral parity with the PS loop on a fixture + a live
   woodev-class workload.

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

- Repo hosting/licensing details for `kalbac/autodev-harness`.
- Which live woodev-class workload to use as the P1 parity target.
- Exact per-project config file format (`.autodev/config.yaml` vs `harness.config.*`).

## Related
- `adr/002-build-own-harness-not-fork-ao.md` — the pivot (supersedes `adr/001`).
- `superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — P1 design.
- `superpowers/donor-extraction/decision-matrix.md` — the verified basis.
