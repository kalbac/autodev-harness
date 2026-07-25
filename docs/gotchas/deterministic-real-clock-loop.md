# `[test/deterministic-real-clock-loop]` — deterministically testing a real-clock poll loop over real subprocesses

**Tag:** `[test/deterministic-real-clock-loop]`
**Found:** s55 (2026-07-25), de-flaking `watchdog.test.ts` (#85).

## The problem

`runWatched` (the watchdog) polls a REAL spawned child and kills it on staleness/timeout,
all keyed on `Date.now()`. Its tests spawned real `node -e` subprocesses with tight
real-time windows (`staleSeconds: 0.6`) and asserted the boolean OUTCOME (`timedOut`).
Under CPU load (many subagents) the real child's stdout was starved past the 0.6s window,
so the watchdog correctly killed it and the "stays alive" assertion flipped — a flaky
failure that is NOT a product bug. A plain `vi.useFakeTimers()` cannot fix this: the child
is a real process on the real event loop; freezing time freezes the child too.

## The fix — separate the DECISION from the IO, then inject a clock + spawn

1. **Extract the per-tick decision into a pure function** (`classifyWatchTick({now, start,
   newestActivity, staleSeconds, timeoutSeconds}) → kill?`). Now the timing correctness is
   proven on plain numbers — no clock, no subprocess — and can never flake. This is where
   the boundary/precedence tests live.
2. **Inject `now()` and `spawn` seams** into the loop (both default to the real ones). A
   deterministic test drives a **fake in-process child** (an `EventEmitter` with
   `stdout`/`stderr`/`stdin.end`, and **no `pid`** so `killTree` no-ops — no OS process is
   touched) plus a controllable clock.

## Two non-obvious traps (both cost a codex round)

- **Seed the injected clock ABOVE the real epoch** (e.g. `2_000_000_000_000`). The loop
  computes `newestActivity = Math.max(lastActivity, heartbeatMtime, activityPathsMtime)`,
  and the heartbeat file's mtime is a REAL wall-clock ms (~1.7e12). A small injected clock
  (`now = 1000`) is dwarfed by it, so `newestActivity` is always "fresh" and the loop never
  goes stale — the test proves nothing. Seed the injected clock above any real mtime.
- **A "stays alive" test is VACUOUS at the strict-`>` boundary unless you advance PAST the
  window.** If you emit activity and THEN advance the clock so total idle lands exactly at
  `staleSeconds*1000`, the strict `idle > window` is false either way — so the test passes
  even if the activity→lastActivity wiring is completely broken. Fix: advance the clock
  BEFORE the emit (so the emit stamps the advanced time) AND run past the window, so a
  BROKEN wiring would go stale and be killed → failing the test. **Mutation-verify it:**
  comment out the `lastActivity = now()` line and confirm the test fails.

## Single vs double clock read

The extraction replaced two adjacent `Date.now()` reads (one for `idle`, one for `elapsed`)
with a single coherent `now()`. This is NOT byte-for-byte behavior-preserving, but a single
snapshot is *more* correct (the two reads differed by sub-microseconds only). Accept it
explicitly rather than contorting the code to preserve a meaningless double-read.

## Related

- [[../GOTCHAS]] — index.
- `[test/vacuous-assert]` — the general "green but proves nothing" class; the strict-`>`
  boundary trap above is a specific instance.
- `[ts/test-hang]` — the other watchdog/loop testing hazard (unterminated async loops).
