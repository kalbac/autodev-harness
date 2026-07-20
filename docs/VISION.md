# Autodev Harness — Vision & Charter

> The anchor document. Read this first, every session. 3-minute re-hydration.
> Authored 2026-07-01. Immutable intent; tactics live in `CURRENT-STATE.md`, the
> invariants and their rationale in `PRINCIPLES.md`.

## Slogan

> **"Let agents code, but never let them merge bullshit."**

## One-paragraph what & why

**Autodev Harness is an execution layer for autonomous AI software development.** An
LLM proposes the work; a **deterministic gate** plus an **independent critic** decide
what is allowed to merge. The bet is not a smarter model — it is a system that does
**not need to trust the model**: acceptance moves from *"the agent said DONE"* to a
verifiable engineering process. Most AI coding tools ask *"how do we make the LLM write
better code?"*; the harness asks *"how does even an imperfect LLM participate in
development safely?"* That is a different problem, and it stays valuable as the
underlying models change.

## The core idea — separate intelligence from execution authority

The worker writes code; it has **no authority to declare its own work correct**. An
independent critic reviews the diff (never Claude-on-Claude), and a mechanical gate
(contract zones, mutation-verified guards, CI) enforces what cannot be argued with. The
gate is **deterministic — an LLM cannot talk its way past it**, because it does not run
in the agent's context. This is the whole reason the project exists; the *why* behind
each invariant is recorded in `PRINCIPLES.md`.

Because the value lives in the *system*, not the model, the harness keeps its worth
when the worker is swapped from one vendor to the next. That model-independence is a
feature, not an accident.

## The single source of truth — the file-blackboard

Harness state lives in a **file-blackboard** (`.autodev/queue|runtime|done`, project
config in `.autodev/config.yaml`), git-trackable, behind a `BlackboardRepository` seam.
There is **no parallel daemon DB** as a competing source of truth. Every component reads
and writes the blackboard; nothing may drift from it. (A SQLite projection / event-log
is deferred to the product phase — as a projection, never as a second truth.)

## What we port from autodev-loop (the proven discipline)

The harness is a TypeScript port of our proven `autodev-loop`, carrying its **policies**
(not its PowerShell plumbing):

- Independent diff-critic gate — heterogeneous by policy (critic family differs from
  worker family), never Claude-on-Claude.
- Contract-zone guards + escalation; mutation-verified test guards.
- Model routing by task complexity (declarative, per-task).
- Anti-drift (intent vs cumulative diff).
- Re-critic-own-fixes — a fix is never self-certified.

Self-critique is explicitly **rejected as the gate** (it is the exact failure mode we
exist to prevent — "critique theater", in-loop self-refinement).

## Roles are a configurable model matrix (`adr/003`)

Roles — **orchestrator, worker, critic, planner, …** — are a first-class open set, each
mapped to a model via a global default + per-project override. **No vendor is bound to a
role**; the current `claude` worker + `codex` critic are just the first fillers of the
matrix. The operator talks to an in-harness **LLM orchestrator** that authors/prioritizes
tasks, triggers the loop, monitors, and reports — but it sits **strictly above** the
enforcement substrate and touches it through exactly four capabilities (enqueue, trigger,
read, report). It has no tool to run/skip/reorder the gate. Enforcement stays deterministic.

## Donor tools (where "the best" comes from)

The harness is **our own build, not a fork** — it assembles the genuinely-best piece from
each donor, verified against real code (`adr/002`, donor-extraction pass):

- **autodev-loop** — the proven critic/gate/contract-zone/anti-drift/routing policies (the base).
- **Agent Orchestrator (AO)** — worktree-per-task isolation, session/PR lifecycle, process-visible UI patterns.
- **OpenHands** — intelligence patterns (risk-based action confirmation, event-stream trajectories, model portability, an eval harness to *measure* the gate's value).
- **Open Design** — UX/extensibility (PATH-scan agent auto-detection, model router + BYOK, first-class skills/plugins/MCP).
- **Aider** — focused edit/diff patterns.

Full basis: `superpowers/donor-extraction/decision-matrix.md` (independently critic-verified).

## Build order (`adr/002`)

**P1 core loop (headless) → P2 web UI → P3 product.** Graftable donor features are phased,
not dumped into the product phase. One language (TypeScript) across core + UI;
cross-platform by design.

## History

`adr/001` decided to **fork AO**. `adr/002` (2026-07-01) superseded that: after a
donor-extraction pass, we build **our own Node+TypeScript harness** with AO demoted to one
donor of four. ADR-001's *reasoning* (don't wait on upstream; keep the critic discipline)
still holds — only "fork AO specifically" was replaced.

## Related

- `PRINCIPLES.md` — the invariants and *why* they exist (the constitution).
- `CURRENT-STATE.md` — what to do next, concretely.
- `adr/002-build-own-harness-not-fork-ao.md` — own build, not a fork.
- `adr/003-roles-are-a-configurable-vendor-matrix.md` — the roles matrix + orchestrator boundary.
- `reference/autodev-loop-runbook.md` — the proven design we are porting.
