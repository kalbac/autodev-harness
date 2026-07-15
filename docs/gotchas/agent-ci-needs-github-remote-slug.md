# `[gate/agent-ci-needs-github-remote-slug]`

**`@redwoodjs/agent-ci run` refuses to start unless it can resolve a GitHub `owner/repo` slug — from a git remote OR the `GITHUB_REPO` env var. The harness sets neither, so it relies entirely on the target repo having a GitHub `origin`.**

Empirically (WSL, s41): a fresh repo with no remote fails immediately, BEFORE any job:
```
[Agent CI] Fatal error: Could not detect GitHub repository from git remotes in <cwd>.
Set the GITHUB_REPO environment variable (e.g. GITHUB_REPO=owner/repo).
```
Adding `git remote add origin https://github.com/<owner>/<repo>.git` (no `GITHUB_REPO`) → agent-ci resolves the slug and runs. A per-task **worktree shares the main repo's remotes**, so if the project's main clone has a GitHub `origin`, the worktree run resolves fine (confirmed s41 on `woodev-shipping-plugin-test`, origin `kalbac/woodev-shipping-plugin-test`).

**Implication:** `gate.agentCi` on a project WITHOUT a GitHub remote → agent-ci emits no `run.finish` → the harness reads it as an infra failure → escalates ("gate threw"), on EVERY task, unfixable by the worker. `buildAgentCiCommand` (`src/gate/agent-ci-exec.ts`) does not inject `GITHUB_REPO`. If we want agent-ci to work on non-GitHub or remote-less repos, the harness must set `GITHUB_REPO` (derive a synthetic `local/<repoName>` when no GitHub origin exists) in the agent-ci env.

Found s41.

## Related
- [[agent-ci-workflow-container-no-checkout]] — the other half of getting agent-ci to actually run a workflow.
- [[agent-ci-worktree-wsl-git-interop]] — the GIT_DIR/config-restore handling for a Windows worktree under WSL.
