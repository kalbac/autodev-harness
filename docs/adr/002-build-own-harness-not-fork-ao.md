# 002 — Build our own harness; AO becomes one donor of several

**Status:** accepted
**Date:** 2026-07-01
**Supersedes:** the core premise of `001-fork-ao-not-wait.md` (AO as the fork base
and single source of truth). ADR-001's *reasoning* (don't wait on upstream; keep the
critic discipline) still holds; only "fork AO specifically" is replaced.

## Context

ADR-001 decided to **fork Agent Orchestrator (AO)** and port autodev-loop's policies
onto it, with AO's session/PR model as the single source of truth. Between then and
now the evaluation widened: additional donor candidates surfaced (OpenHands, Open
Design, Aider) that each do *some* piece better than AO. Betting the whole harness on
AO's skeleton would inherit AO's shape wholesale and forfeit the best ideas from the
others. The operator reframed the goal: **not a fork of any single tool, but our own
harness assembling the "best of" each donor on top of our own proven autodev-loop.**

To decide this on facts rather than impressions, we ran a **Donor Extraction pass**:
cloned all four donors into `references/` (git-ignored, pinned SHAs in `MANIFEST.md`),
studied each with a dedicated agent plus a fifth agent that reverse-engineered our own
PowerShell loop into a parity spec, synthesized a decision matrix, and had an
independent **codex GPT-5.5** critic verify the architecture-shaping claims against the
real code (17/18 confirmed, 1 partial, none refuted). Artifacts:
`docs/superpowers/donor-extraction/`.

## Decision

**Build a standalone harness** — `github.com/kalbac/autodev-harness`, a new repo, not a
fork — in **Node LTS + TypeScript**: a headless daemon (a TS port of our proven
autodev-loop) plus a local web UI, with the **file-blackboard as the single source of
truth**. AO is demoted to **one donor among four**. The six skeleton axes are frozen
by the verified decision matrix:

1. **State** — file-blackboard is truth (git-tracked), behind a `BlackboardRepository`
   seam; SQLite projection + event-log deferred to the product phase.
2. **Worker interface** — pluggable `WorkerAdapter`/`CriticAdapter` from day one; MVP
   ships `claude` + `codex` adapters (3-donor convergence: AO `ports.Agent`, OpenHands
   ACP, Open Design registry).
3. **Checkpoint** — conductor commits to the loop branch **after** the gate; `Checkpoint`
   seam for a future PR adapter.
4. **Isolation** — per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate** — independent diff-critic + machine gate; **self-critique rejected** as a
   gate (Open Design "Critique Theater", OpenHands in-loop refinement — both are the
   failure mode we exist to prevent); `GateExtension` seam for action-level risk.
6. **Routing** — our declarative per-task `model:` routing kept (no donor does
   complexity routing; Open Design's "AMR smart router" is a myth); thin `Router` seam.

Build order: **P1 core loop (headless) → P2 web UI → P3 product** (Electron/Tauri +
grafts). Graftable donor features are phased (P1-fast-follow / P2-era / P3), not all
dumped into the product phase.

## Consequences

- **+** The harness takes the genuinely-best piece from each donor, verified against
  real code, instead of inheriting one tool's whole shape.
- **+** Our proven loop is the base; the new core is a module-for-module TS port against
  a living parity oracle (the PS loop keeps running until parity — continuity).
- **+** One language (TS) across core + UI; cross-platform (kills the PowerShell
  Windows-lock); product-ready foundation.
- **−** More to build than a fork would have been (no free AO daemon/UI). Mitigated by
  the small, proven scope of P1 and permissive donor licenses (all Apache-2.0/MIT →
  code, not just ideas, is reusable).
- **−** We now maintain a real codebase from scratch rather than tracking an upstream.

## Related
- `../superpowers/donor-extraction/decision-matrix.md` — the verified basis (VERIFIED).
- `../superpowers/donor-extraction/codex-verification.md` — independent critic pass.
- `../superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — the P1 design.
- `001-fork-ao-not-wait.md` — the decision this supersedes.
