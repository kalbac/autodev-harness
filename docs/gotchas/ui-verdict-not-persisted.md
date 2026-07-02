# `[ui/verdict-not-persisted]` — the critic verdict is not a runtime file, so the dashboard's verdict-first-class is rich only on escalation

**Tag:** `[ui/verdict-not-persisted]`
**Discovered:** s14 (2026-07-02), building the dashboard's Verdict inspector tab.

## What

The dashboard's whole thesis is surfacing the critic verdict FIRST-CLASS. But
the conductor does **not** persist the verdict object (`{verdict:
clean|broken|uncertain, confidence, notes, broken_contracts}`) as a per-task
runtime file. What actually lands on disk per task:

- `worker-report.md`, `diff.patch` — always (once the worker runs).
- `critic-feedback.md` — only when the critic returned **non-clean** (retry feedback).
- The escalation body (`escalations/<taskId>.md`) — only when the task **escalated**;
  it carries the verdict type + the critic notes as evidence.
- A `digest.md` line like `[critic] <id> verdict=... confidence=...` — for every run.

So:

- **Escalated task** → rich verdict is readable via `GET /escalations/:id` (the
  A/B card + the UNCERTAIN/BROKEN "verdict seal" render real critic notes). This
  is where "never merge bullshit" is most visible — a refusal.
- **Clean-committed task** → there is NO readable verdict artifact; the only
  signal is the digest line. The dashboard's Verdict tab shows a synthesized
  "clean → committed" seal without confidence/notes.

## Implication for the UI (accepted for the MVP)

The verdict-first-class surface is strongest exactly where it matters (a gate
refusal). For committed tasks the UI shows the digest line + a clean seal. This
was accepted for s14 — it keeps the change out of the frozen conductor/gate.

## Backlog (if we want verdict+confidence for committed tasks too)

Have the conductor write `critic-verdict.json` as a runtime file at critic time
(additive `repo.writeRuntimeFile`, like `diff.patch`). Then the dashboard reads
it uniformly for any task. This **touches the conductor** (enforcement-adjacent),
so it gets the full sonnet-TDD → spec-check → codex GPT-5.5 → re-critic gate.

## Related

- `[conductor/worker-report]` — per-task runtime files + the harvest dance.
- [[CURRENT-STATE]] — NEXT ACTIONS optional UI follow-ups.
