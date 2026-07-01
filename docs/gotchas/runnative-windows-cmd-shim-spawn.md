# Gotcha — `runNative` can't spawn a Windows `.cmd` shim without cross-spawn

**Tag:** `[node/win-cmd-spawn]` · **Found:** s09 (2026-07-02), live build-step-9 run — the `codex` critic failed `spawn codex ENOENT`. Fixed in `src/util/native.ts` (`76e0ab3`).

## The trap

`node:child_process.spawn("codex", args)` (no `shell`) **cannot launch a PATH command that resolves to a Windows `.cmd`/`.bat` shim.** The npm-global `codex` is `codex` (POSIX script) + `codex.cmd` (Windows shim); node's `spawn` only tries `.exe` via PATHEXT, so `codex` → **ENOENT**. And node 22 **refuses to spawn `.cmd` directly without a shell** (CVE-2024-27980, EINVAL), so even `spawn("codex.cmd")` fails.

Why `claude` worked but `codex` didn't: `claude` is `claude.exe` (node finds it); `codex` is a `.cmd` shim.

## The fix

`runNative` spawns via **`cross-spawn`** instead of `node:child_process`. cross-spawn resolves the command through PATH+PATHEXT and, for a shim, invokes `cmd.exe /d /s /c` with `windowsVerbatimArguments` + escaped quotes — so an arg like `model_reasoning_effort="high"` survives intact. On POSIX it is a transparent passthrough.

## Notes

- cross-spawn types `stdout`/`stderr` as **nullable** (null only for non-`pipe` stdio, which we never request) → optional-chain those accesses to satisfy `strict`.
- The prior EPIPE `child.stdin?.on("error")` swallow is unaffected — cross-spawn returns an ordinary `ChildProcess`.
- Regression test is **win32-gated** (`it.runIf(process.platform === "win32")`) — it spawns a real `.cmd` (`npm`) by bare name; uninteresting on POSIX.

## Lesson (cross-project)

On Windows, any tool installed as an npm-global (or other `.cmd`/`.ps1` shim) needs cross-spawn (or `shell:true` + manual quoting) to launch by bare name from node. Bare `spawn` is a silent Windows-only ENOENT trap.

## Related
- `docs/gotchas/child-stdin-epipe-unhandled.md` — the other `runNative` hazard.
- `docs/gotchas/codex-exec-windows-sandbox-review-inline-diff.md` — the other codex-on-Windows gotcha.
