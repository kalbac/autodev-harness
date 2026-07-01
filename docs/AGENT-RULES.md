# Agent Rules — Autodev Harness

> For AI agents. Keep updated.
> Navigation → `DOCS-INDEX.md` | Status → `CURRENT-STATE.md` | Anchor → `VISION.md`

## Session Start Checklist

1. Read `VISION.md` — the mission and the single-source-of-truth rule
2. Read `CURRENT-STATE.md` — phase status, NEXT ACTIONS, open questions
3. Scan `GOTCHAS.md`
4. If touching ported logic, read the relevant `reference/` doc

## Session End Checklist

1. Update `CURRENT-STATE.md` — status + next actions (≤3 lines of "last session")
2. Prepend a 10–20 line entry to `SESSION-LOG.md`
3. Compile: scan the new log entry for gotchas → `gotchas/{slug}.md` + `GOTCHAS.md` index
4. Commit docs (Conventional Commit)

## Workflow Rules

### Discuss before coding
Any non-imperative request is open for discussion. If an approach seems wrong or
there's a better one, say so **before** implementing. Give honest opinion when asked.

### Fork hygiene is rule #1
This is a fork. Keep a clean `upstream` remote. Land our features as **isolated
commits / a plugin layer**, never tangled into upstream files — so AO updates pull
cleanly. Every change: ask "does this make the next upstream merge harder?"

### The critic gate applies to our OWN work
The whole point of this project is "never merge bullshit" — that includes our code.
Substantial changes get an **independent codex GPT-5.5 review** before merge.
**Re-critic your own in-place fixes** — never self-certify. (This caught 2 incomplete
fixes in the parent project on 2026-06-07.)

### Verify before "done"
Never claim done on words alone. Run it, observe behaviour, verify each CI job is a
pass and CLEAN before merge. Squash-merge on green CI; never `gh pr merge --auto`.

### Single source of truth
AO's session/PR model is authoritative. Do NOT reintroduce autodev-loop's file
blackboard as a parallel state store. Port policies, not plumbing (`VISION.md`).

## Coding Conventions

- **Go (daemon)** and **TypeScript/Electron (UI)** — match upstream AO style.
- Prefer **Serena MCP** for source navigation over raw Read (once source is cloned).
- **Conventional Commits** required.
- Isolate our additions from upstream files wherever possible (fork hygiene).

## Communication

- Russian for discussion with the operator; English for docs, code, commits.
- Recommended option first in any choice; ground proposals in the actual source,
  not assumptions.
