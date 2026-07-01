# Gotcha — unhandled `child.stdin` EPIPE crashes the run

**Tag:** `[node/stdin-epipe]` · **Discovered:** s08 (2026-07-01), first cross-platform CI run (Task 29). Fixed in `src/util/native.ts` at commit `790ffc9`.

## The trap

`runNative` (`src/util/native.ts`) writes the caller's `stdin` to the child and
closes the pipe with `child.stdin.end(...)`. That write **races the child closing
its read end**: a child that never reads stdin and exits fast (many `git`
subcommands, or anything that `process.exit()`s early) leaves the pipe's reader
gone, so the `end()` write raises **EPIPE**.

That EPIPE is benign here — the child's `stdout`/`stderr`/`exit` are captured by
their own listeners, so we have the real result regardless. But a stream `'error'`
with **no `'error'` listener** becomes an **unhandled error event**, which Node
throws — **crashing the whole run**, not just failing one call.

It is a **race**, so it is flaky: s08's first cross-platform matrix went red only
on **ubuntu/node20**; the other 3 cells (win/linux × 20/22) passed the same code.
Do not dismiss a one-cell EPIPE as infra noise — it was a real bug.

## The fix

Attach a swallowing `'error'` handler to `child.stdin` **before** writing:

```ts
child.stdin?.on("error", () => {}); // benign EPIPE when child exits before reading
child.stdin?.end(options.stdin ?? "");
```

Fail-open is correct: the write failing means the child already went away, and its
output/exit are captured separately. Do **not** reject the promise on stdin error —
that would turn a benign race into a spurious failure.

## The regression test

Deterministic repro in `src/util/native.test.ts` — spawn a child that exits
immediately and write a payload **larger than the OS pipe buffer** so the write is
guaranteed to hit the closed reader:

```ts
const r = await runNative(process.execPath, ["-e", "process.exit(0)"], {
  stdin: "x".repeat(1_000_000),
});
expect(r.exitCode).toBe(0); // resolves, does not throw
```

A small stdin can fit the pipe buffer and never trigger EPIPE — the 1 MB payload is
what makes it deterministic.

## Related
- `docs/gotchas/never-throws-catch-block-logging.md` — the sibling fail-closed /
  best-effort-module discipline (a "never-throws" seam must not throw on its edges).
- `src/util/native.ts` — the `runNative` seam (parity with PS `Invoke-Native`).
