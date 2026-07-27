# `[eval/corpus-lock-survives-a-killed-run]`

**Found:** s59 (2026-07-27), self-inflicted while re-running the corpus for `adr/007`.

## What happens

`eval` takes exclusive ownership of a project by writing
`<repoRoot>/.autodev/corpus.lock` (`{"pid":…,"startedAt":…}`) at startup. If the run is
KILLED rather than allowed to finish, the lock file stays on disk. The next run then
starts, restores the baseline for case 1, and **fails every case with**:

```
eval: another corpus run holds this project (…\.autodev\corpus.lock:
{"pid":11896,…}). A corpus run takes exclusive ownership of the harness state.
```

The report it writes looks like a real measurement and is not one:

| Metric | Value |
|---|---|
| First-pass commit rate | 0% |
| Escaped-defect rate | 0% |
| Total wall-clock | **0.0s** |
| Tokens (worker / critic) | **0 / 0** |

All seven cases read `errored — no evidence record`. The refusal itself is CORRECT and
fail-closed; the trap is that its output is shaped exactly like a catastrophic regression
(`0%`, everything failing) and can be misread as one.

**The tells that this is infrastructure, not measurement:** wall-clock `0.0s`, tokens
`0 / 0`, and every case `errored` rather than a mix of outcomes. A real run of 7 cases
takes ~11 minutes and spends tens of thousands of tokens. Read those three fields before
reading the metric table.

## Why it bit

Two mistakes compounded, both mine:

1. **The run was launched as a bash background job.** That is the shape
   `[orchestrator/bg-spawn-killed]` warns about — the nested `claude -p` worker spawn gets
   killed. Recognising that, I stopped the job and relaunched via `Start-Process`… but
   the stopped run had already written the lock.
2. **The "is the polygon clean?" check globbed the wrong name.** I looked for
   `.autodev/corpus-lock*`; the file is `.autodev/corpus.lock`. The glob matched nothing,
   I reported the polygon clean, and relaunched into a held lock.

A check that can only ever print "clean" is not a check. If a verification step never
fails in practice, confirm it can fail at all before trusting it.

## What to do

Before any corpus run, verify all four, by exact name:

```bash
cd <polygon>
cat .autodev/corpus.lock 2>/dev/null      # must not exist
ls .autodev/queue/pending .autodev/queue/active .autodev/queue/escalated   # all empty
git status --short                         # empty
git log --oneline -1                       # at the intended --baseline
```

If a lock exists, confirm the pid is actually dead before removing it:

```bash
tasklist //FI "PID eq <pid>" | grep -c <pid>   # 0 = dead, safe to delete
rm .autodev/corpus.lock
```

A killed run also leaves a **`corpus seed: <case-id>` commit** on top of the baseline
(the baseline restore for case 1 ran before the lock check failed). `git reset --hard
<baseline>` on the polygon clears it — the polygon only, never the harness repo
(`[git/reset-hard-discards-others-uncommitted]`).

## Related

- `[orchestrator/bg-spawn-killed]` — why the run must be launched detached
  (`Start-Process`) and not as a bash background job. This gotcha is its downstream cost.
- `[git/reset-hard-discards-others-uncommitted]` — the reset above applies to the
  polygon; the harness repo is off-limits.
- `[ops/codex-quota-exit-zero]` — the same family: a run that produced no verdict
  reporting something that looks like a verdict.
- #131, #132, #135 — the other manual/hygiene steps a corpus run needs on Windows.
