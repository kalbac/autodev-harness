# SESSION LOG — Autodev Harness

> Newest entry on top. 10–20 lines per session.

---

## s01 — 2026-07-01 — Bootstrap & charter

**Context:** Spun out of a woodev-framework orchestrator session. Operator was
evaluating AO (Agent Orchestrator) as a replacement/complement for our
project-bound `autodev-loop` and hit its limits: no per-task model routing, no
critic-reviewer setting, and a chat-scroll bug in the desktop UI.

**Decisions:**
- **Fork AO** rather than wait for upstream to grow our features (`adr/001`).
- Project name **Autodev Harness**; slogan *"Let agents code, but never let them
  merge bullshit."*
- **Single source of truth = AO's session/PR model.** Port autodev-loop's
  *policies* (critic gate, contract-zone guards, model routing, anti-drift), drop
  its *plumbing* (PowerShell conductor, file-queue blackboard).
- Build in three ROI-ordered tiers (Tier-0 orchestrator-driven → Tier-1 small fork
  changes → Tier-2 deep native). Tier-1 = `--model` per-task, scroll-bug fix,
  critic kanban column.

**Done:**
- Scaffolded `docs/` with the proven woodev-framework structure.
- Wrote `VISION.md`, `CLAUDE.md`, `CURRENT-STATE.md`, `AGENT-RULES.md`,
  `DOCS-INDEX.md`, `DOCS-SCHEMA.md`, `GOTCHAS.md`, `FUTURE-BACKLOG.md`, `adr/001`.
- Ported crown reference docs: `reference/autodev-loop-runbook.md`,
  `reference/ao-codex-critic-protocol.md`.
- `git init` + initial commit.

**Not done / next:** AO source not cloned yet. Next session: clone AO, set up
fork hygiene (upstream remote), scope Tier-1 with real effort numbers. See
`CURRENT-STATE.md` → NEXT ACTIONS.
