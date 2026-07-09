# `[gate/agent-ci-not-runnable-on-native-windows]`

> Found s37 (2026-07-10), during the live-prove of the optional agent-ci gate-hardening
> feature (`gate.agentCi`). Detail file for the `docs/GOTCHAS.md` index.

## The gotcha

`@redwoodjs/agent-ci@0.16.2` **cannot run on native Windows** — it fails BEFORE it ever
reaches Docker. Even `agent-ci run --help` dies with:

```
tar (child): Cannot connect to C: resolve failed
tar: Child returned status 128
[Agent CI] Fatal error: Error: Command failed:
  tar -czf C:\Users\...\AppData\Local\Temp\dtu_cache\__empty__.tar.gz -T /dev/null
    at ... node_modules/dtu-github-actions/dist/server/routes/cache.js:18
```

agent-ci's cache layer shells out to `tar -czf C:\...\file.tar.gz ...`. On a box whose PATH
`tar` is the **Unix/MSYS tar** (git-bash's), a `C:\...` argument is parsed as a **remote
host** (`host:path` rsync-style syntax) → "Cannot connect to C:". The tool has no
Windows-path handling in that path; it is a Linux-first tool that assumes a POSIX `tar`.

## Why it matters for the harness

The `gate.agentCi` feature runs `npx @redwoodjs/agent-ci run --workflow <p> --json` in the
per-task worktree. On a Windows operator box, that invocation fails at the tar step, exits
non-zero, and emits **no parseable `run.finish` event** → `parseWorkflowOutcome` returns
`"infra"` → `runAgentCiWorkflows` **throws** → `runGate` propagates the throw → the conductor
escalates it as `"gate threw -- broken operator config"`. **This is exactly correct
behavior** (an unfixable environment problem must ESCALATE, not loop the worker forever), and
it was live-proven for real on this box (not simulated): the module and `runGate` both threw
with `produced no parseable run.finish event (exit 1) -- treating as an infrastructure
failure`.

## Rule / consequence

- **`gate.agentCi` is a Linux/WSL-only feature in practice.** An operator on native Windows
  who enables it will see every task ESCALATE with the broken-config reason. That is the
  designed fail-safe, but it means the feature is not usable on a native-Windows host.
- To actually USE agent-ci (and to live-prove the pass / job-fail branches), run under **WSL**
  or a Linux host, where the POSIX `tar` + paths + Docker all work (Docker Desktop's WSL
  integration exposes the same daemon). Native Windows only exercises the infra-escalate branch.
- Do NOT try to "fix" this in the harness by shimming agent-ci's tar — it is agent-ci's own
  bug, in a vendored dependency (`dtu-github-actions`), outside our code. Our correct posture
  is the infra-failure ESCALATE, which already works.

## Related

- `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md` — the feature spec.
- `docs/superpowers/plans/2026-07-10-agent-ci-gate-hardening.md` — the implementation plan.
- `src/gate/agent-ci.ts` — the module whose throw-on-infra contract makes this fail SAFE.
- `[node/win-cmd-spawn]`, `[detect/executable-probe]` — sibling Windows-native-tooling gotchas.
