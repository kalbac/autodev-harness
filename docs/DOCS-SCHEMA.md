# DOCS SCHEMA — Autodev Harness

> Format + compilation rules for `docs/`. Keep docs consistent and low-drift.

## Principles

- **Single source of truth per fact.** Phase status lives in `CURRENT-STATE.md`
  only; mission in `VISION.md` only; the *why* of the invariants in `PRINCIPLES.md`
  only; history in `SESSION-LOG.md` only. Do not duplicate a fact across files —
  link instead.
- **Absolute dates** (`DD.MM.YYYY` or ISO), never relative ("yesterday", "next week").
- Every doc under `docs/` ends with a `## Related` section linking neighbours. (Repo-root
  files — `README.md`, `CLAUDE.md` — are exempt: they are entry points with their own
  navigation sections.)
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
# {A title that states the FINDING, not the topic}

**Tag:** `[namespace/topic]` · Found sNN (DD.MM.YYYY)

## What happens
{The observable failure, with the evidence that established it —
 measured numbers, verbatim output, the commit it bit.}

## Why {it hid / it is not what it looks like}
{Optional but usual: the non-obvious part. If it were obvious it
 would not be a gotcha.}

## What to do
{The rule, stated so a future reader can apply it without re-deriving it.}

## Related
{Sibling gotchas, the principle it enforces, the ADR that decided it.}
```

The headings are a guide, not a schema — several gotchas are better told in a different
shape, and that is fine. What is **mandatory**: the `# title`, the `**Tag:**` line with a
session and date, and a closing `## Related`. A gotcha states a *finding*
("the critic's evidence window is the diff hunk"), never a topic ("about the critic").

## Related

- `AGENT-RULES.md` — when to run the compilation protocol.
- `DOCS-INDEX.md` — where each doc lives.
