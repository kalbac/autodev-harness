# DOCS SCHEMA — Autodev Harness

> Format + compilation rules for `docs/`. Keep docs consistent and low-drift.

## Principles

- **Single source of truth per fact.** Phase status lives in `CURRENT-STATE.md`
  only; mission in `VISION.md` only; the *why* of the invariants in `PRINCIPLES.md`
  only; history in `SESSION-LOG.md` only. Do not duplicate a fact across files —
  link instead.
- **Absolute dates** (`DD.MM.YYYY` or ISO), never relative ("yesterday", "next week").
- Every doc ends with a `## Related` section linking neighbours.
- English for all docs.

## File roles

| File | Holds | Never holds |
|---|---|---|
| `PRINCIPLES.md` | The invariants + *why* they exist (the constitution) | Status, tactics, history |
| `VISION.md` | Immutable mission, slogan, architecture rule | Tactics, status |
| `CURRENT-STATE.md` | Live status + NEXT ACTIONS + recent-session one-liners | Full session narratives |
| `SESSION-LOG.md` | Full history, newest on top | Status tables |
| `GOTCHAS.md` | Index only | Gotcha bodies (those go to `gotchas/{slug}.md`) |
| `adr/NNN-*.md` | One decision + tradeoffs | Status |

### CURRENT-STATE is a snapshot, not a log

The #1 drift we already hit: CURRENT-STATE grew into a second SESSION-LOG (139 KB by
s46). To prevent recurrence: at session end the previous session's live block is
**replaced**, not appended. The new full narrative goes to `SESSION-LOG.md`;
CURRENT-STATE keeps only the live status + a one-line pointer per recent session. Target
≤ ~150 lines.

## Compilation protocol (session end)

1. New/changed behaviour that could bite later → a gotcha: create
   `gotchas/{slug}.md`, add one index line to `GOTCHAS.md`, bump the count.
2. A decision with real tradeoffs → an ADR: `adr/{NNN-title}.md` + index in
   `adr/README.md`.
3. Deep topic explanation, or an **Architecture Note** (rationale — *why* the system
   is built this way, not what the code does) → `wiki/{topic}.md`. This is the home for
   design rationale and analysis memos; do **not** create a competing `architecture/`
   folder (that re-introduces the multi-source-of-truth drift).

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
