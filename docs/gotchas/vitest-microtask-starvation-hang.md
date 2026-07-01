# `[ts/test-hang]` — an unterminated async loop with no-op deps HANGS vitest uncatchably

**Tag:** `[ts/test-hang]`
**Seen:** s07 (conductor tests)

## Symptom
The whole vitest run is **killed at a process-level timeout** (e.g. 5 min) with
`Exit code 143` / "Worker exited unexpectedly", and **no per-test failure** is
printed. `--reporter=verbose` shows only the `RUN` header — results never flush.
The offending file simply never completes.

## Cause
A test that drives an **infinite async loop whose awaited dependencies are all
resolved-immediately microtasks** (e.g. the conductor's `run()` with a fake
`sleep: async () => {}` and a scheduler that never terminates the loop) chains
microtasks forever and **never yields to the macrotask queue**. vitest's
per-test `testTimeout` is a `setTimeout` (a macrotask), so it **can never fire** —
the timeout is starved. Only an OS-level process kill stops it.

In s07 two conductor tests triggered this:
- the `MaxSessionHours` test set the fake clock to 2h *before* `run()`, so
  `startMs` was captured as 2h and `elapsed` stayed `0` → the top-of-loop budget
  check never fired → infinite idle loop (fake `sleep` = no-op).
- (a second test asserted an idle sleep with `maxIterations:1`, which correctly
  breaks *before* the sleep step — a wrong expectation, not a hang, but found in
  the same pass).

The conductor logic was correct in both cases; the **tests** were wrong.

## Fixes / rules
1. **Any test that calls a `while(true)`-style loop MUST guarantee termination**
   via the injected controls: `maxIterations`/`once`, or a **clock that actually
   advances** (`let n=0; now: () => (n++ === 0 ? 0 : BIG)` so `startMs`=0 and the
   next read trips the budget). Never pin a monotonic clock to a constant when
   the code captures a baseline from it.
2. To locate the hang: bisect with `-t "<describe substring>"`; the subset that
   still hangs contains the culprit.
3. Run the conductor/heavy suites with
   `--pool=forks --poolOptions.forks.singleFork=true` — orphaned tinypool
   workers from prior *killed* runs pile up (s07 saw **186 node procs → OOM**);
   kill strays by command line (`Get-CimInstance Win32_Process ... -match
   'vitest|tinypool'`), never blanket-kill node (MCP servers).

## Harness gotcha (related)
In this Claude Code harness, **issuing a new foreground shell command KILLS the
currently-running background command.** "Waiting" `echo`s were silently killing
the very test runs they were meant to wait on. To wait on a long run, launch it
and issue **no** further tool calls until its completion notification arrives.

## Related
- [[conductor-wiring-deferred-limitations]]
- `src/conductor/conductor.test.ts` — the fixed tests.
