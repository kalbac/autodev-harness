# CLAUDE.md — Autodev Harness

> **Slogan:** "Let agents code, but never let them merge bullshit."
> Autodev Harness is an execution layer for autonomous AI software development: an
> LLM proposes the work, and a deterministic gate + an independent critic decide
> what is allowed to merge. Read `docs/VISION.md` first — it is the anchor.

## Session Start Protocol

At the start of **every** session, read in this order:
1. `docs/VISION.md` — mission, single-source-of-truth rule, roles-matrix (the anchor)
2. `AGENTS.md` — the agent contract for this repo (language, git-ownership, batch-merges, review discipline)
3. `docs/CURRENT-STATE.md` — phase status, next concrete actions, open questions
4. `docs/GOTCHAS.md` — scan the index to avoid repeated mistakes
5. `docs/reference/` — the ported reference docs (autodev-loop runbook + critic protocol)

## What this project is

**Our own Node + TypeScript build** — not a fork. The harness assembles the best
ideas from four donor tools (Agent Orchestrator, OpenHands, Open Design, Aider) on
top of the proven `autodev-loop` critic discipline. See `docs/adr/002` (why we
stopped forking AO) and `docs/adr/003` (roles are a configurable model matrix).

- **Core idea:** separate *intelligence* from *execution authority*. The LLM decides
  what to write; the harness decides whether that decision may pass. The gate stays
  deterministic — an LLM cannot talk its way past it.
- **Single source of truth:** the file-blackboard (`.autodev/queue|runtime|done`,
  project config in `.autodev/config.yaml`). NOT a daemon DB. See `docs/VISION.md`.
- **Roles** (orchestrator, worker, critic, planner, …) are a configurable
  model matrix — no vendor is bound to a role (`docs/adr/003`).

## Status

**Active development.** Working Node daemon + web UI; attended live-orchestrator
presence shipped; the unattended-autonomy half is partly built. For the live phase
status and next actions see `docs/CURRENT-STATE.md` — it is the single source of
truth for "where we are". Do not track status here (it rots).

## Documentation Structure (`docs/`)

| File / dir | Purpose |
|---|---|
| `PRINCIPLES.md` | The invariants and *why* they exist — the constitution (read when a guard looks "unnecessary") |
| `VISION.md` | Mission anchor — read first, every session |
| `CURRENT-STATE.md` | Live phase status, known issues, next actions (NOT history) |
| `SESSION-LOG.md` | Full session history (newest entry on top) |
| `GOTCHAS.md` | Gotcha index → `gotchas/{slug}.md` atomic files |
| `AGENT-RULES.md` | Workflow + coding rules for AI agents |
| `DOCS-INDEX.md` | Navigation hub for all docs |
| `DOCS-SCHEMA.md` | Doc format + compilation rules |
| `FUTURE-BACKLOG.md` | Deferred features / tech debt |
| `adr/` | Architecture Decision Records |
| `wiki/` | Deep-dive topic references |
| `reference/` | The ported reference docs (autodev-loop runbook, critic protocol) |
| `archive/` | Resolved historical docs |

## Coding Conventions

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), Node ≥ 20. Backend is
  `src/**` → built to `dist/`; the dashboard is the separate `ui/` sub-project
  (web, Vite + shadcn/Base UI — **not** Electron).
- **Rebuild both bundles after backend changes** (`npm run build` AND `npm run build:ui`).
- Match the existing module style in `src/**`; keep new work in its own module rather
  than tangling it into unrelated files.
- Prefer **Serena MCP** for source navigation over raw Read.
- **Conventional Commits** for all commits (`feat:`, `fix:`, `docs:`, `refactor:` …).
- **Critic discipline applies to OUR OWN work too:** substantial changes get an
  independent codex **gpt-5.6-luna** review before merge; re-critic in-place fixes —
  never self-certify (this is the whole point of the project). Pin the critic model.

## Session End Protocol

1. Update `docs/CURRENT-STATE.md` — **replace** the previous session's live block, don't
   append; the new detail goes to SESSION-LOG (see `DOCS-SCHEMA.md`)
2. Prepend a 10–20 line entry to `docs/SESSION-LOG.md`
3. Scan the new log entry for gotchas → `docs/gotchas/{slug}.md` + index in `GOTCHAS.md`
4. Commit docs: `git commit -m "docs: <summary>"`

## MCP Tools available (global)

Serena (semantic code nav — prefer for TS source), Context7 (library docs),
Supermemory (cross-project memory), Obsidian, Codex (`/codex:review`, rescue).
Use Serena for source navigation, not raw Read.
