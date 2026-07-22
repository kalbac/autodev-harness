# `[ops/codex-cancel-broken-under-git-bash]`

> `/codex:cancel` cannot kill a job when the companion is invoked from git-bash:
> MSYS rewrites the `/PID` flag into a path. The job then stays `running` forever
> in the plugin's registry, and any agent or shell waiting on it hangs with it.
> Found s51.

## What happens

The companion cancels a job by shelling out to `taskkill /PID <n> /T /F`. Under
git-bash, MSYS path conversion turns the `/PID` **flag** into a **path**:

```text
taskkill /PID 10616 /T /F: exit=1: ERROR: Invalid argument/option - 'C:/Program Files/Git/PID'.
```

The kill never happens, and — worse — the registry entry is never marked finished.

## Why it is not just cosmetic

A job whose process has already died stays listed as `running` indefinitely. In
s51 one stalled review sat at "1h 05m, phase: starting" with its process (PID
10616) long dead, and it kept **two** background tasks alive behind it: the
subagent waiting for a completion notification that could never arrive, and the
shell that had launched it. Neither could be stopped from the UI.

Do not diagnose this from the status output alone — it says `running`, which is
exactly the wrong thing. Check whether the PID is actually alive:

```powershell
(Get-Content -Raw "<state-dir>\state.json" | ConvertFrom-Json).jobs |
  Where-Object { $_.status -eq 'running' } |
  ForEach-Object { "{0} pid={1} alive={2}" -f $_.id, $_.pid, [bool](Get-Process -Id $_.pid -ErrorAction SilentlyContinue) }
```

## Workarounds

- **Cancel from PowerShell, not bash** — no MSYS conversion, so the flag survives.
  Note the job registry is **per shell session**: a job started from bash is not
  visible to a PowerShell invocation of the companion (`Session runtime: shared
  session` vs `direct startup`), so this only helps if the job was started there.
- **Clear a phantom entry by hand** once its PID is confirmed dead: patch the
  entry in `<state-dir>/state.json` (`status: "failed"`, `phase: "done"`, add
  `completedAt`) — the per-job `jobs/<id>.json` is NOT what the status command
  reads, so patching only that file changes nothing.
- **Prefer running codex directly** for long reviews:
  `cat prompt.txt | codex exec --model <pinned> --skip-git-repo-check -`. It is
  synchronous, its output is returned directly, and no registry entry can go
  stale. A 67 KB prompt exceeds the Windows command-line limit, so pass it on
  **stdin** — not as an argument.

## Related

- `gotchas/codex-exec-windows-sandbox-review-inline-diff.md` — the other
  Windows-specific codex constraint (it cannot spawn subprocesses, so files must
  be pasted into the prompt).
