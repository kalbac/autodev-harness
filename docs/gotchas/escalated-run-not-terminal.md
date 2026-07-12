# `[narrator/escalated-run-not-terminal]` — an escalated run leaves the thread "running" forever + the narrator idle-ticks

**Found:** s40 live-prove.

## What happened

`NarratorService` decides a run is finished (sets thread meta `status:done|error`, calls `stop()` which clears its `setInterval` + CI subscriptions) only when **every task is terminal**, where terminal = `done` OR `quarantine` (see `diffRunSnapshot` run_finished logic + the narrator terminal check). An **escalated** task is NOT terminal — it is parked awaiting an operator A/B reply. So a run whose only task escalates (e.g. the critic returns `broken`) leaves the thread pinned at `status:running` indefinitely, and the narrator keeps ticking every 1.5s doing nothing until the daemon stops. Observed live twice (critic `broken` on an invented FAQ doc; a stray-file dirty escalation): the escalation CELL + narration appeared correctly ("The task hit a snag and escalated..."), so the operator IS told — but the thread never resolves to a clear "needs your input" state and the idle loop runs forever.

## Why it's not a correctness bug (yet)

The escalation is surfaced (cell + prose), R1/gate are untouched, nothing is lost. It's a UX + resource-hygiene gap: (a) no distinct thread status for "blocked on operator," (b) a wasteful idle `setInterval`. The felt criterion still reads (the escalation narrates as a story).

## Fix (s41 chat-polish, deferred)

Treat "all tasks terminal-OR-escalated, none active/pending" as a narrator stop condition: set a `blocked` thread status (distinct from `done`/`error`), append a final "waiting on your reply" narration, and `stop()` the idle loop. Re-arm/resume the narrator when the operator replies to the escalation (reply moves the task out of `escalated/` per `[escalate/replied-holds-filelock]`, so a fresh narrator can pick the run back up). Add a `blocked` glyph to the sidebar `ThreadList` + rail.

## Related
- `[escalate/replied-holds-filelock]` — reply moves an escalated task out of `escalated/` (the resume hook).
- `docs/adr/004-...` — attended presence; the "blocked" state is chat-polish, sits ahead of the unattended-half brainstorm.
