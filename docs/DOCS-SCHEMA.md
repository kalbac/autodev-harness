# DOCS SCHEMA — Autodev Harness

> Format + compilation rules for `docs/`. Keep docs consistent and low-drift.

## Principles

- **Single source of truth per fact.** Phase status lives in `CURRENT-STATE.md`
  only; mission in `VISION.md` only; history in `SESSION-LOG.md` only. Do not
  duplicate a fact across files — link instead.
- **Absolute dates** (`DD.MM.YYYY` or ISO), never relative ("yesterday", "next week").
- Every doc ends with a `## Related` section linking neighbours.
- English for all docs.

## File roles

| File | Holds | Never holds |
|---|---|---|
| `VISION.md` | Immutable mission, slogan, architecture rule | Tactics, status |
| `CURRENT-STATE.md` | Live status + NEXT ACTIONS (≤3 lines "last session") | Full history |
| `SESSION-LOG.md` | Full history, newest on top | Status tables |
| `GOTCHAS.md` | Index only | Gotcha bodies (those go to `gotchas/{slug}.md`) |
| `adr/NNN-*.md` | One decision + tradeoffs | Status |

## Compilation protocol (session end)

1. New/changed behaviour that could bite later → a gotcha: create
   `gotchas/{slug}.md`, add one index line to `GOTCHAS.md`, bump the count.
2. A decision with real tradeoffs → an ADR: `adr/{NNN-title}.md` + index in
   `adr/README.md`.
3. Deep topic explanation → `wiki/{topic}.md`.

## Gotcha file template

```markdown
# {Title}
**Tag:** [namespace/topic]  **Recorded:** DD.MM.YYYY
## The mistake
## The correct pattern
## Why
## Related
```

## Related

- `AGENT-RULES.md` — when to run the compilation protocol.
- `DOCS-INDEX.md` — where each doc lives.
