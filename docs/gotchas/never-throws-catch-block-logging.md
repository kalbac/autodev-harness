# A "never-throws" module must guard its catch-block logging too

**Tag:** `[ts/fail-closed]`
**Discovered:** s06 (2026-07-01), codex gate + re-critic on `escalate` / `anti-drift`.

## The trap

A module whose contract is "best-effort, never throws" (e.g. `escalate.ts`, and
the fail-closed degradation path in `anti-drift.ts`) typically wraps each side
effect in `try/catch`. It is easy to leave the **logger call inside the catch
block** unguarded:

```ts
try {
  await deps.runModel(...);
} catch (err) {
  deps.log?.("WARN", `... ${err}`);   // ← if deps.log throws, the function REJECTS
}
```

An injected logger (or `env()` reader) that throws re-introduces a throw path
through the very `catch` that was supposed to make the code fail-closed. The
happy-path tests pass; the contract is silently broken. The codex re-critic
caught this as an "incomplete fix" after the first pass only guarded the primary
call.

## The fix

Route **every** log/env call reachable on a failure path through a local
`safeLog` that swallows a throwing logger:

```ts
const safeLog = (level: string, message: string): void => {
  try { deps.log?.(level, message); } catch { /* a broken logger must never break delivery */ }
};
```

Same pattern for a throwing `env()`: read it inside a `try` and degrade (e.g.
treat Telegram as unconfigured) rather than letting it escape.

## Rule of thumb

If a module's docstring says "never throws" / "best-effort", audit **all**
injected-dependency calls — not just the obvious I/O — including the ones inside
`catch` blocks and after the last `try`. A regression test should inject a
throwing logger AND a throwing primary dependency together.

## Related
- `docs/gotchas/codex-exec-windows-sandbox-review-inline-diff.md` — how the gate that found this runs on Windows.
- `docs/SESSION-LOG.md` — s06 entry (findings F1/F4 + re-critic).
