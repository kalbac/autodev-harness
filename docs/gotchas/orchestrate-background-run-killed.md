# Gotcha: background `orchestrate` runs get killed during the nested `claude` decompose spawn

**Tag:** `[orchestrator/bg-spawn-killed]`
**Found:** s12 (2026-07-02), aurora live proof.

## Symptom

Running `node dist/index.js orchestrate "<intent>"` as a **background** command (Claude Code
`run_in_background: true`) was KILLED partway — the log stopped at:

```
[INFO] orchestrator: decomposing intent
```

with no error, no enqueue, no partial state. Two consecutive background attempts were both killed at
the same point (the `ClaudeOrchestratorAdapter` spawning `claude -p --model opus` for decompose). The
SAME command run in the **foreground** completed cleanly through to a green COMMIT.

## Likely cause (not fully root-caused)

The orchestrator's decompose step spawns the `claude` CLI as a child process from inside a process that
was itself launched by a Claude Code session. Nested/background `claude` spawns appear to get reaped in
this environment (session-turn boundary and/or resource contention). Note: two EARLIER background runs
(same session, ~4h prior) DID complete — so it is intermittent, not a hard block.

## Workaround

**Run `orchestrate` in the FOREGROUND** for live proofs (Bash tool, generous `timeout` — a
dependency-free docblock/message task completes in ~3–5 min; a worker+critic task ~4–5 min). Foreground
also surfaces the real exit code / stderr instead of a silent "killed".

## Silver lining (design confirmation)

The killed runs left aurora perfectly clean — no partial task in `queue/pending/`, no dangling worktree.
This confirms the staged pipeline's transactional design: `handleIntent` only enqueues AFTER a full
decompose + validate-all-or-nothing, so an interrupted decompose leaves nothing behind.

## Related

- `[ts/test-hang]` — the other "background process gets killed" gotcha (a NEW foreground shell command
  kills a running background one; distinct mechanism, same operational lesson: prefer foreground for
  live LLM runs you need to observe).
- `docs/gotchas/orchestrator-forbidden-paths-overlap.md` — the decompose-output gotcha from the same proof.
