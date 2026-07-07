# `[env/serena-churn-blocks-merge]` — a tracked `.serena/` perpetually dirties the tree → no task ever reaches DONE

**Symptom (s31, operator-hit).** On a real project every task escalated with
`worktree merge blocked: main working tree is not clean` — even right after a full
`git reset --hard` + `git clean` that verified `git status --porcelain` empty. Nothing
ever reached DONE.

**Cause.** `.serena/project.yml` (and `.serena/memories/*`) are **git-tracked**, and the
Serena MCP language server **rewrites them in the background** whenever it touches the
project (indexing, cache stamp). So the main working tree goes dirty again *during* a run.
`mergeAfterGate` refuses to merge into a dirty main tree (`git status --porcelain` non-empty)
→ the gate-approved COMMIT can't merge back → the task escalates (`blocked`). Since the
s31 fix, this escalates gracefully instead of hanging in ACTIVE — but it still never lands.

This is the SAME class as `.autodev/` runtime churn (already noted in
[[harness-on-real-repo-prerequisites]]): a tracked directory that tooling auto-writes
will dirty the tree and block every merge. `.autodev/` is git-excluded here; `.serena/`
was not.

**Fix (demo/immediate):** neutralise the churn on the tracked files without a commit —
```
git checkout -- .serena
git ls-files .serena | xargs -I{} git update-index --skip-worktree {}
```
`--skip-worktree` makes `git status` (and therefore `mergeAfterGate`) ignore later writes.
Verify `git status --porcelain` is empty, then re-run → the merge lands, task → DONE.

**Fix (product, backlog):** the **New Project onboarding** should git-exclude known
tooling-churn dirs (`.serena/`, `.autodev/`) when it scaffolds `.autodev`, and warn on a
dirty tree. See FUTURE-BACKLOG "scaffold: git-exclude tooling-churn dirs". Operator asked:
"maybe add serena to gitignore by default?" — yes.

**Also (Windows):** the same test repo had an untracked file literally named `nul` (a
Windows reserved device name). `git clean` can't remove it (`Permission denied`), so it
kept the tree dirty. Remove via the `\\?\` long-path prefix:
`Remove-Item -LiteralPath '\\?\D:\...\nul' -Force`.

## Related
- [[harness-on-real-repo-prerequisites]] — `.autodev` churn + clean-tree prereq (same class)
- [[daemon-serve-verb-and-autodev-branch-guard]] — other real-repo run prerequisites
- `[conductor/merge-precondition-escalate]` (s31 fix) — a dirty tree now escalates `blocked`, not orphan-in-ACTIVE
