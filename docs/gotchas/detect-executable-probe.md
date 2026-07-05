# `[detect/executable-probe]` — PATH-scan agent detection: `existsSync` is a false-positive both ways, and a kill deadline needs SIGTERM→SIGKILL

**Found:** s26 (2026-07-05), building the PATH-scan auto-detect of installed CLI agents (`src/detect/detect-agents.ts`, `GET /agents/detect`). Three codex-gate findings, all real.

## Context

Detection walks the PATH for a curated catalog of agent binaries and reports `available` + resolved `path` + best-effort `version`. It is a **separate read-only probe** from spawn-time resolution — `runNative`/`cross-spawn` owns the actual launch (and its PATHEXT/`.cmd`-shim handling, gotcha `[node/win-cmd-spawn]`). So detection re-implements its own PATH walk, and that walk has non-obvious pitfalls.

## Pitfall 1 — a bare `existsSync(join(dir, bin))` MISSES a Windows shim

On win32 the real binary is often `codex.cmd` / `claude.EXE`, not a bare `codex`. `existsSync(join(dir, "codex"))` returns false → false "not installed", even though `cross-spawn` resolves and runs it fine at spawn time. Detection MUST walk `dirs × extensions`, where extensions = `(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")` on win32 and `[""]` on POSIX. This is the flip side of `[node/win-cmd-spawn]`: the spawn path is handled by cross-spawn, but the DETECTION path is our own code and needs its own PATHEXT logic.

## Pitfall 2 — `existsSync` is TRUE for a directory / a non-executable file

`existsSync(candidate)` is true for a *directory* named `codex` (or `codex.cmd`), or a plain non-executable file of that name → a false "installed". A candidate counts only if it is a real **file** and, on POSIX, is `X_OK`-executable:

```ts
function isExecutableFile(p: string, platform: NodeJS.Platform): boolean {
  try { if (!statSync(p).isFile()) return false; } catch { return false; }
  if (platform === "win32") return true;              // PATHEXT match already implies executable
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}
```

`statSync` follows symlinks (a symlink→executable is correctly accepted; a symlink→dir correctly rejected via `isFile()===false`). Use `path.resolve` (not `join`) so the reported `path` is absolute even for a relative PATH entry; empty PATH segments (= cwd) are deliberately dropped so cwd is never probed.

## Pitfall 3 — a version-probe kill deadline needs SIGTERM→SIGKILL, not a single `kill()`

The version probe spawns `<bin> --version` under a timeout. A first cut resolved the promise on timeout but LEFT the child running (`withTimeout` returned null) → a repeatedly-hit endpoint could accumulate orphans. Fix: give the shared `runNative` an opt-in `timeoutMs` that kills the child (the kill triggers `close`, which resolves normally). But a single `child.kill()` sends **SIGTERM**, which a POSIX child can trap/ignore → the promise would then hang forever. The deadline must **SIGTERM, then escalate to SIGKILL after a grace period**. On Windows both map to a forceful TerminateProcess, so the first kill already ends it. Keep the option opt-in (default unset = no timer) so the enforcement-critical worker/critic/gate callers of `runNative` are byte-for-byte unaffected. Test with a child that TRAPS SIGTERM (`process.on('SIGTERM', () => {})`) to prove the SIGKILL escalation actually terminates it.

## Also — a simulated-platform test must not depend on the host FS casing

The win32 PATHEXT test injects `platform:"win32"` but runs on the real host. Writing `codex.cmd` and injecting PATHEXT `.CMD` makes the resolver look for `codex.CMD`, which fails on a case-SENSITIVE Linux CI FS. Write the fixture with the SAME casing the resolver produces (`codex.CMD`) so the test is portable. The POSIX `X_OK` guard test is only meaningful on POSIX (win32 maps `X_OK`→`R_OK`) — gate it with `it.skipIf(process.platform === "win32")`.

## Related
- `[[runnative-windows-cmd-shim-spawn]]` (`[node/win-cmd-spawn]`) — the spawn-time side: cross-spawn handles the shim so `exe` stays a bare name; detection is the separate read-only probe.
- `[[win-83-shortpath-realpath-divergence]]` — another win-vs-CI path divergence class.
- `src/detect/detect-agents.ts`, `src/util/native.ts` (`timeoutMs`), `src/api/server.ts` (`GET /agents/detect`).
