# Autodev Harness — Vision & Charter

> The anchor document. Read this first, every session. 3-minute re-hydration.
> Authored 2026-07-01. Immutable intent; tactics live in `CURRENT-STATE.md`.

## Slogan

> **"Let agents code, but never let them merge bullshit."**

## One-paragraph what & why

**Autodev Harness** is a fork of **Agent Orchestrator (AO)**
(`github.com/AgentWrapper/agent-orchestrator`) that fuses AO's minimalist,
process-visible UI with the **proven adversarial-critic discipline** of our
`autodev-loop`. AO gives us the body and the dashboard (session supervision,
git-worktree isolation, a kanban board, PR tracking). autodev-loop gives us the
brain (an independent GPT-5.5 critic gate, contract-zone guards, model routing by
complexity, anti-drift). Neither alone is enough: AO merges whatever passes CI;
autodev-loop is powerful but hard-wired to one project and has no UI. The harness
is the symbiosis — **agents produce code fast, and an independent critic + machine
gate refuse to let bullshit merge.**

## Why fork instead of waiting for AO

- AO is at version `dev`; its roadmap is external and may never grow our
  killer features (contract-zone guards, mandatory critic gate, model-by-complexity).
- Waiting = betting our workflow on someone else's priorities. Forking = control.
- autodev-loop already **proved** the critic-gate economics; its only real flaw is
  being welded to a single project. The harness removes that flaw.

See `adr/001-fork-ao-not-wait.md` for the full decision record.

## The core architectural rule — SINGLE source of truth

autodev-loop stored state in a file blackboard (`.autodev/queue|runtime|done`).
AO stores state in its own daemon DB (sessions / PRs / kanban). **We do NOT run
both.** The harness keeps **AO's session/PR model as the single source of truth**
and **ports autodev's POLICIES, not its plumbing**:

| We KEEP from autodev-loop (policy/intelligence) | We DROP (AO already does it better) |
|---|---|
| Independent GPT-5.5 critic gate (never Claude-on-Claude) | PowerShell conductor |
| Contract-zone guards + escalation | File-queue blackboard |
| Model routing by task complexity | Manual worktree management |
| Anti-drift critic (intent vs diff) | Bespoke heartbeat/watchdog files |
| Re-critic-own-fixes rule | — |

## What we take from AO (keep & protect)

- Minimalist Electron UI, kanban board, **process visibility** (the reason to switch).
- `ao spawn` fresh-worktree sessions, `ao send`, session lifecycle.
- Project config in the UI (model, permissions, harness).
- `ao review submit` — the hook that lets our critic verdict show in the UI.

## The build plan — three tiers (ROI-ordered)

- **Tier 0 — orchestrator-driven, zero fork (works today).** Critic gate, contract
  zones, and model bump live in the orchestrator agent + thin wrappers. Already
  specified in `reference/ao-codex-critic-protocol.md`.
- **Tier 1 — small, high-ROI fork changes.** (a) `--model` per-task on `ao spawn`;
  (b) **fix the chat-scroll bug** (Electron frontend — likely small); (c) surface
  the critic verdict as a first-class kanban column. **This is where the fork earns
  its keep.**
- **Tier 2 — deep native integration.** Critic-gate + contract-zone as native AO
  concepts; a model-by-complexity router in the UI.

## Fork hygiene (non-negotiable)

Keep a clean `upstream` remote to AO. Land our features as **isolated commits / a
plugin layer**, never tangled into upstream files, so we can pull AO updates without
merge hell. This is the #1 risk of the whole effort — manage it from commit one.

## Known first targets (from operator)

1. Per-task model selection by complexity (AO only has a static per-project override).
2. The **chat-scroll bug** in the AO desktop UI (can't scroll back through history).
3. Mandatory codex GPT-5.5 critic surfaced in the UI.

## Related

- `reference/autodev-loop-runbook.md` — the proven design we are porting.
- `reference/ao-codex-critic-protocol.md` — Tier-0 critic gate on AO, already written.
- `adr/001-fork-ao-not-wait.md` — the fork decision.
- `CURRENT-STATE.md` — what to do next, concretely.
