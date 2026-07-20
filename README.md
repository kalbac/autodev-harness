# Autodev Harness

> **Let agents code, but never let them merge bullshit.**

Autodev Harness is an execution layer for autonomous AI software development. An LLM
proposes the work; a **deterministic gate** and an **independent critic** decide what
is allowed to merge. The value is not a smarter model — it is a system that does not
need to *trust* the model: it moves acceptance from "the agent said DONE" to a
verifiable engineering process.

It is **our own Node + TypeScript build** (not a fork), assembling the best ideas from
four donor tools — [Agent Orchestrator](https://github.com/AgentWrapper/agent-orchestrator),
OpenHands, Open Design, and Aider — on top of the proven `autodev-loop` critic
discipline.

## The core idea

- **Intelligence is separated from execution authority.** The worker writes code; it
  has no authority to declare its own work correct.
- **An independent critic** reviews the diff (never Claude-on-Claude), and a
  **mechanical gate** (contract zones, mutation-verified guards, CI) enforces what
  cannot be argued with. The gate is deterministic — an LLM cannot talk past it.
- **Roles are a configurable model matrix** — orchestrator, worker, critic, planner.
  No vendor is bound to a role; the current models are just the first fillers, and the
  harness keeps its value when the underlying models change.
- **The file-blackboard (`.autodev/`) is the single source of truth** for queue,
  runtime, and done state.

See [`docs/PRINCIPLES.md`](docs/PRINCIPLES.md) for the invariants and *why* each exists.

## Status

**Active development.** A working Node daemon + web dashboard: the attended
live-orchestrator presence (chat as the project's main screen) is shipped, and the
unattended-autonomy half is partly built. See
[`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) for live status and next steps.

## Running it

```bash
npm install
npm run build        # backend → dist/
npm run build:ui     # dashboard → ui/dist

node dist/index.js serve   # daemon + dashboard on :4319
# or
node dist/index.js run     # headless run from a project directory
```

Requires Node ≥ 20. For development without a build: `npm run dev` (backend, via tsx)
and `npm run dev:ui` (dashboard).

## Start here (docs)

- [`docs/PRINCIPLES.md`](docs/PRINCIPLES.md) — the invariants and why they exist (the constitution)
- [`docs/VISION.md`](docs/VISION.md) — mission and architecture rule (the anchor)
- [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) — where we are, what to do next
- [`docs/DOCS-INDEX.md`](docs/DOCS-INDEX.md) — navigation hub for everything else

## For AI agents

Read [`CLAUDE.md`](CLAUDE.md) and [`docs/AGENT-RULES.md`](docs/AGENT-RULES.md) first.
