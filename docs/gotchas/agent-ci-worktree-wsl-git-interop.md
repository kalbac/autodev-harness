# `[gate/agent-ci-worktree-wsl-git-interop]` — agent-ci in a Windows-created git worktree under WSL: two git-interop traps

**Tags:** `[gate/agent-ci-worktree-wsl-git-interop]`
**Found:** s38 (2026-07-11), by a real daemon+browser live-prove of the agent-ci observability feature.

## Context

The harness runs the optional `gate.agentCi` step inside the per-task **git worktree**. On
Windows that worktree is created by **Windows git**, and agent-ci runs **inside WSL** (the WSL
proxy — agent-ci can't run on native Windows, see `[gate/agent-ci-not-runnable-on-native-windows]`).
That Windows-worktree ↔ WSL-git ↔ agent-ci combination hides **two** distinct blockers that
unit tests could never surface — only driving a real task through the daemon (worker → gate →
critic → **merge**) exposed them. The observability code was correct throughout (it streamed +
persisted + escalated honestly); these are agent-ci↔git-interop bugs in how the gate invokes it.

## Trap 1 — WSL git can't follow the worktree's Windows-path gitdir pointer → HEAD unresolvable

A linked worktree's `.git` is a **file** containing `gitdir: <path>`. Windows git writes that
path in **Windows form**: `gitdir: D:/Projects/app/.git/worktrees/task1`. When agent-ci runs
`git rev-parse HEAD` (its `resolveHeadSha`) **inside WSL**, WSL git reads that `.git` file and
treats `D:/...` as a **relative** path → `fatal: not a git repository:
/mnt/d/.../worktrees/task1/D:/Projects/...`. agent-ci then emits **only `run.start`** and
fatals → the gate correctly reads "no terminal `run.finish`" as an **infra failure → escalate**.
So with `gate.agentCi.enabled` every real run on Windows/WSL escalated — green unit tests, 100%
useless in production (same class as `[gate/agent-ci-ndjson-keyed-by-event-not-type]`).

**Fix:** derive the WSL form of the worktree's real gitdir and set **`GIT_DIR`** for the WSL
spawn. `worktreeGitDirWsl(<.git file content>)` parses `gitdir: <winpath>` → `winToWslPath` →
`/mnt/d/...`; `buildAgentCiCommand` (wsl mode) prepends `export GIT_DIR='<wsl gitdir>' && `.
Native Linux/Mac is untouched (a POSIX gitdir → `winToWslPath` returns null → no export).

## Trap 2 — agent-ci MUTATES the shared `.git/config`, corrupting the main repo for the conductor

Once `GIT_DIR` points agent-ci at the worktree's gitdir, agent-ci's git operations write to the
config that gitdir resolves to — which, for a **linked worktree, is the MAIN repo's
`.git/config`** (shared via `commondir`). Two mutations were observed, each breaking the
**Windows conductor's post-gate git**:

1. **`GIT_WORK_TREE` → `core.worktree = /mnt/...`.** Setting `GIT_WORK_TREE` (the first fix
   attempt set it alongside `GIT_DIR`) makes git persist `core.worktree = /mnt/d/...` into the
   shared config. The Windows conductor then hits `fatal: Invalid path '/mnt'` on `git rev-parse`
   / `git worktree remove`. **Fix: set `GIT_DIR` ONLY, never `GIT_WORK_TREE`** — agent-ci's
   host-git calls are all `rev-parse`, which need only `GIT_DIR`.
2. **agent-ci flips `core.bare = true`** (and overwrites `user.name`/`user.email`) on the shared
   config during its run. That leaves the **main working tree "bare"**, so the conductor's
   post-gate merge fails `git merge ...: fatal: this operation must be run in a work tree` and
   the task escalates `blocked` — even though the gate passed and the worker's change was
   already committed to the loop branch. **Fix: snapshot `<repoRoot>/.git/config` before the
   agent-ci run and restore it in a `finally` after** (the conductor is single-threaded per
   project and blocked awaiting the gate, so nothing else touches the config meanwhile; restore
   on throw too — an infra/timeout run can still have flipped `core.bare`).

## The combined fix (s38, all in `src/gate/agent-ci-exec.ts` + `src/composition/root.ts`)

- `agent-ci-exec.ts`: `worktreeGitDirWsl()`; `buildAgentCiCommand` wsl branch prepends **`export
  GIT_DIR='<wsl gitdir>' && `** (GIT_DIR only).
- `root.ts` `runAgentCi` closure: best-effort derive `gitDirWsl` from `<wt.path>/.git`; and
  **snapshot+restore `<repoRoot>/.git/config`** around `runAgentCiWorkflows` (native + wsl alike
  — agent-ci mutates the config on any platform; the harness just never drove the full
  worker→gate→**merge** flow before s38, which is why it went unseen until the live-prove).

## Lesson

An external tool that "just runs your CI" can silently **mutate the git repo you point it at**
(config, refs) — and if you point it at a *linked worktree*, it corrupts the *main* repo through
the shared config. Isolate it: give it only what it needs (`GIT_DIR`), never a work-tree binding,
and snapshot/restore any shared state it might touch. And **live-prove the whole product flow**
(through the merge, not just the gate) — every one of these traps passed the unit tests and the
module-level checks; only a real task reaching DONE through the daemon surfaced them.

## Related

- `[gate/agent-ci-not-runnable-on-native-windows]` — why WSL is used at all (the sibling `tar C:\` trap).
- `[gate/agent-ci-ndjson-keyed-by-event-not-type]` — the s37 "green tests, useless in prod" trap this rhymes with.
- `[env/serena-churn-blocks-merge]` — another "main tree not clean → merge refused" cause (the `.serena/` churn; onboarding should exclude `.serena/`+`.autodev/`).
- `[conductor/real-repo-run]` — the main-tree-must-be-clean merge precondition.
- Spec: `docs/superpowers/specs/2026-07-10-agent-ci-observability-design.md`; plan: `docs/superpowers/plans/2026-07-11-agent-ci-observability.md`.
