# Autodev Harness — Vision & Charter

> The anchor document. Read this first, every session. 3-minute re-hydration.
> Authored 2026-07-01. Immutable intent; tactics live in `CURRENT-STATE.md`.

> ⚠️ **DIRECTION UPDATE (2026-07-01, same day) — read `adr/002` first.**
> We are **no longer forking AO.** After a verified donor-extraction pass, the harness
> is **our own Node+TypeScript build** assembling the best of four donors (AO, OpenHands,
> Open Design, Aider) on top of our proven autodev-loop, with the **file-blackboard as the
> single source of truth** (not AO's DB). The **mission below still holds** — critic
> discipline, contract zones, model routing, anti-drift, "never merge bullshit." Only the
> *base and single-source-of-truth* changed. Where this doc says "fork AO" / "AO's session
> model as truth," it is **superseded by `adr/002`** and the frozen skeleton in
> `superpowers/specs/2026-07-01-harness-p1-core-loop-design.md`.

> ⚠️ **ROLE MODEL (2026-07-01, s04) — see `adr/003` (proposed).**
> Roles (**orchestrator, worker, critic, planner, …**) are a **configurable model matrix**:
> the operator picks which model fills each role, via global defaults + per-project overrides.
> **No vendor is bound to a role** — the current `claude` worker + `codex` critic are just the
> first two MVP role-implementations, not a lock. The operator talks to an in-harness **LLM
> orchestrator** that drives the run; the **gate/enforcement stays deterministic** (an LLM can't
> talk past it). This refines skeleton axes 2 + 6 and diverges from parity §2's pure-code
> conductor — reconciled in `adr/003`.

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

## Donor tools (where "the best" comes from)

- **AO** — the fork base: body, UI, kanban, session/PR source of truth.
- **autodev-loop** — the proven critic/gate/contract-zone/anti-drift policies.
- **OpenHands** (`github.com/OpenHands/OpenHands`, MIT) — **intelligence-pattern donor**
  (Python + TS, so ideas not code-merge): risk-based action confirmation, append-only
  event-stream trajectories, ACP multi-backend, LiteLLM model portability,
  microagents, sandbox runtime, and an eval harness to *measure* the gate's value.
  Full analysis: `wiki/openhands-analysis.md`.
- **Open Design** (`github.com/nexu-io/open-design`, Apache-2.0) — **UX/extensibility
  donor** (also Electron, so UI patterns port well): PATH-scan **auto-detection of
  installed CLI agents**, a clean three-tier UI, a model router + BYOK proxy, and
  first-class skills / plugins / MCP integrations, plus a pre-emit self-critique lint.
  Full analysis: `wiki/opendesign-analysis.md`.

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
