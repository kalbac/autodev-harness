# CLAUDE.md — Autodev Harness

> **Slogan:** "Let agents code, but never let them merge bullshit."
> This project is a fork of Agent Orchestrator (AO) that ports the proven
> autodev-loop critic discipline onto AO's UI + supervisor. Read `docs/VISION.md`
> first — it is the anchor.

## Session Start Protocol

At the start of **every** session, read in this order:
1. `docs/VISION.md` — mission, single-source-of-truth rule, tier plan (the anchor)
2. `AGENTS.md` — the agent contract for this repo (language, git-ownership, batch-merges, review discipline)
3. `docs/CURRENT-STATE.md` — phase status, next concrete actions, open questions
4. `docs/GOTCHAS.md` — scan the index to avoid repeated mistakes
5. `docs/reference/` — the two crown docs we are porting (runbook + critic protocol)

## What this project is

A fork of **Agent Orchestrator** (`github.com/AgentWrapper/agent-orchestrator`).
- **Upstream tech:** Go daemon (`ao` binary) + **Electron** desktop UI (TypeScript/web frontend).
- **Our mission:** graft autodev-loop's *policies* (independent GPT-5.5 critic gate,
  contract-zone guards, model-by-complexity routing, anti-drift) onto AO's *infra*
  (session supervision, worktree isolation, kanban UI), with **AO's session/PR model
  as the single source of truth**. See `docs/VISION.md`.

## Status

**Day zero — planning/bootstrap.** The fork has NOT been cloned yet. First real
engineering step is to pull the AO source and scope Tier-1 (see `docs/CURRENT-STATE.md`).

## Documentation Structure (`docs/`)

Proven layout carried over from the woodev-framework project:

| File / dir | Purpose |
|---|---|
| `VISION.md` | Mission anchor — read first, every session |
| `CURRENT-STATE.md` | Phase status, known issues, next actions |
| `SESSION-LOG.md` | Full session history (newest entry on top) |
| `GOTCHAS.md` | Gotcha index → `gotchas/{slug}.md` atomic files |
| `AGENT-RULES.md` | Workflow + coding rules for AI agents |
| `DOCS-INDEX.md` | Navigation hub for all docs |
| `DOCS-SCHEMA.md` | Doc format + compilation rules |
| `FUTURE-BACKLOG.md` | Deferred features / tech debt |
| `adr/` | Architecture Decision Records |
| `wiki/` | Deep-dive topic references |
| `reference/` | Crown source docs being ported (runbook, critic protocol) |
| `archive/` | Resolved historical docs |

## Coding Conventions (to be firmed up once source is cloned)

- **Daemon changes:** Go — match AO's existing style; keep our additions in isolated
  files/packages, never tangled into upstream files (fork hygiene, see VISION).
- **UI changes:** Electron + TypeScript — same isolation discipline.
- **Fork hygiene is rule #1:** clean `upstream` remote to AO; pull updates without
  merge hell. Land our features as isolated commits / a plugin layer.
- **Conventional Commits** for all commits (`feat:`, `fix:`, `docs:`, `refactor:` …).
- **Critic discipline applies to OUR OWN work too:** substantial changes get an
  independent codex GPT-5.5 review before merge; re-critic in-place fixes — never
  self-certify (this is the whole point of the project).

## Session End Protocol

1. Update `docs/CURRENT-STATE.md` — status, next actions (max ~3 lines of "last session")
2. Prepend an entry to `docs/SESSION-LOG.md` (10–20 lines)
3. Scan the new log entry for gotchas → `docs/gotchas/{slug}.md` + index in `GOTCHAS.md`
4. Commit docs: `git commit -m "docs: <summary>"`

## MCP Tools available (global)

Serena (semantic code nav — prefer for Go/TS source), Context7 (library docs),
Supermemory (cross-project memory), Obsidian, Codex (`/codex:review`, rescue).
Use Serena for source navigation, not raw Read, once the source is cloned.
