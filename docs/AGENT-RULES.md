# Agent Rules — Autodev Harness

> For AI agents. Keep updated.
> Navigation → `DOCS-INDEX.md` | Status → `CURRENT-STATE.md` | Anchor → `VISION.md`
> Why the invariants exist → `PRINCIPLES.md`

## Session Start Checklist

1. Read `VISION.md` — the mission and the single-source-of-truth rule
2. Read `CURRENT-STATE.md` — phase status, NEXT ACTIONS, open questions
3. Scan `GOTCHAS.md`
4. If touching ported logic, read the relevant `reference/` doc

## Session End Checklist

1. Update `CURRENT-STATE.md` — **replace** the previous session's live block (don't append);
   the new detail belongs in SESSION-LOG (see `DOCS-SCHEMA.md`)
2. Prepend a 10–20 line entry to `SESSION-LOG.md`
3. Compile: scan the new log entry for gotchas → `gotchas/{slug}.md` + `GOTCHAS.md` index
4. Commit docs (Conventional Commit)

## Workflow Rules

### Discuss before coding
Any non-imperative request is open for discussion. If an approach seems wrong or
there's a better one, say so **before** implementing. Give honest opinion when asked.

### Keep our modules isolated
Land features as **self-contained modules** under `src/**`, never tangled into
unrelated files. Every change: ask "does this make the code harder to reason about,
or couple two concerns that should stay separate?" (This replaces the old fork-hygiene
rule — we are no longer a fork; see `adr/002`.)

### The critic gate applies to our OWN work
The whole point of this project is "never merge bullshit" — that includes our code.
Substantial changes get an **independent codex gpt-5.6-luna review** before merge
(pin the model). **Re-critic your own in-place fixes** — never self-certify. (This
caught 2 incomplete fixes in the parent project on 2026-06-07, and a fix that leaked a
narrower version of the same bug across 4 rounds in s46.)

### Verify before "done"
Never claim done on words alone. Run it, observe behaviour, verify each CI job is a
pass and the critic is CLEAN before merge. Squash-merge; never `gh pr merge --auto`.

**Green CI is a precondition for merging, not a trigger.** Whether the merge then
happens depends on presence — attended, it waits for the operator's in-turn word;
unattended/overnight, the standing grant applies. `AGENTS.md` ("Git ownership") is
the single statement of that policy; do not restate the condition here, or the two
drift apart again (they did, until s49 reconciled them).

### Single source of truth
The file-blackboard (`.autodev/queue|runtime|done`, project config in
`.autodev/config.yaml`) is authoritative. Do **not** introduce a parallel state store
(e.g. a daemon DB) that could drift from the blackboard (`VISION.md`, `adr/002`).

## Coding Conventions

- **Backend:** TypeScript, ESM, Node ≥ 20 (`src/**` → `dist/`). **Dashboard:** the
  separate `ui/` web sub-project (Vite + shadcn/Base UI — not Electron).
- Prefer **Serena MCP** for source navigation over raw Read.
- **Conventional Commits** required.
- Keep our additions in their own modules; match the existing style in `src/**`.

## Communication

- Russian for discussion with the operator; English for docs, code, commits.
- Recommended option first in any choice; ground proposals in the actual source,
  not assumptions.

## Related

- `PRINCIPLES.md` — the invariants and why they exist.
- `CLAUDE.md` — session start/end protocol, coding conventions, MCP tools.
- `DOCS-SCHEMA.md` — doc format + compilation protocol.
