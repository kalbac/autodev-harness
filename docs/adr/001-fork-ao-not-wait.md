# 001 — Fork AO instead of waiting for upstream

**Status:** accepted
**Date:** 2026-07-01

## Context

We evaluated **Agent Orchestrator (AO)** as a replacement/complement for our
project-bound `autodev-loop`. AO's strengths are real and hard to replicate: a
minimalist Electron UI, a kanban board, genuine process visibility, git-worktree
session isolation, and PR tracking. Its weaknesses block our workflow:

- No **per-task model routing** — only a static per-project `--model` override.
  autodev-loop chose the model by task complexity.
- No **critic-reviewer** concept — `ao review submit` only records a verdict; it runs
  no independent critic. Our workflow mandates an independent GPT-5.5 critic gate.
- A **chat-scroll bug** in the desktop UI (can't scroll back through history).
- AO is at version `dev`; its roadmap is external. Our killer features
  (contract-zone guards, mandatory critic gate) may never land upstream.

The alternative to forking is to stay on Tier-0 (orchestrator-driven wrappers) and
wait for AO to grow the features. That bets our workflow on someone else's
priorities, with no guarantee AO ever covers what autodev-loop already does.

## Decision

**Fork AO** into a standalone project, **Autodev Harness**, and port autodev-loop's
proven *policies* onto it. Keep **AO's session/PR model as the single source of
truth**; do not reintroduce autodev-loop's file-blackboard as a parallel state
store. Manage upstream-merge risk via strict fork hygiene (clean `upstream` remote,
isolated feature commits / plugin layer).

## Consequences

- **+** Full control over the features that matter; the proven critic economics get a
  UI and stop being welded to one project.
- **+** Tier-0 still works today, so there is no gap while the fork matures.
- **−** Standing upstream-merge debt — the #1 ongoing risk; mitigated by fork hygiene.
- **−** We now own a Go daemon + Electron app; broader surface than a PowerShell loop.

## Related

- `../VISION.md` — the charter this decision anchors.
- `../reference/autodev-loop-runbook.md` — the policies being ported.
- `../reference/ao-codex-critic-protocol.md` — Tier-0 gate already specified.
