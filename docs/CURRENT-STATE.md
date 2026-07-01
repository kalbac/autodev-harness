# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (s03 — P1 foundation built: steps 1–2, 42 tests green).

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
| **P1 — Core loop (headless TS daemon)** | 🔨 **in progress — plan written; build-order steps 1–2 done (config, blackboard, git, worktree); 42 tests green; PR #1** |
| P2 — Web UI (localhost dashboard over the core) | ⬜ pending |
| P3 — Product phase (Electron/Tauri wrap + grafts) | ⬜ pending |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s03, 2026-07-01)

- Wired `origin`; adopted **PR-flow** (push-to-`main` is classifier-gated) → **PR #1** on `feat/p1-core-loop`.
- Wrote the P1 **implementation plan**; built **build-order steps 1–2** subagent-driven (sonnet-5) with
  a **codex GPT-5.5 gate per module** — 42 tests green, typecheck clean, all codex findings fixed + regression-tested.
- Repo hygiene (gitignore `references/`+`next-session-promt.md`); decided Apache-2.0 + `.autodev/config.yaml`.

## NEXT ACTIONS (s04)

1. **Merge PR #1** (operator) — brings in the foundation + repo-hygiene cleanup. Until merged, the
   flagged files remain on `main`.
2. **Continue build order (§10) steps 3–9**, same discipline (sonnet-5 implementer → codex GPT-5.5 gate):
   `router` → `worker`(claude adapter)+`prompt` → `critic`(codex adapter)+fencing → `gate`+`guards`+`mutation-check`
   → `watchdog`+`escalate`+`anti-drift` → `conductor` → thin `api` → parity harness + cross-platform CI.
   Plan tasks 8–29 in `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md` (interfaces pinned; expand each to full TDD when reached).
3. **Pick the live woodev-class parity target** (operator) — needed only at build step 9 (DoD).
4. **Definition of done for P1:** behavioral parity with the PS loop on a fixture + that live workload.

**Assets:** foundation modules under `src/{util,config,blackboard,worktree}/`; `src/index.ts` is a stub
awaiting the `conductor` wiring (plan Task 24).

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
