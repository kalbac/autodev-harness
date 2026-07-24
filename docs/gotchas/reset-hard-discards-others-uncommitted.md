# `[git/reset-hard-discards-others-uncommitted]` — `git reset --hard` on a shared tree discards the operator's UNCOMMITTED work

**Tag:** `[git/reset-hard-discards-others-uncommitted]`
**Found:** s54 (a real incident, mid-session)

## What happened

After squash-merging PR #117, the agent synced local `main` with:

```sh
git reset --hard origin/main
```

The working tree was **not clean** — it carried the operator's long-standing
**uncommitted** edits to `package.json`, `package-lock.json`, and (session-added)
`.claude/settings.json` (his OpenCode config, flagged in the handoff as "his, leave
alone"). `reset --hard` reverted all three tracked files to the committed version,
**discarding his edits**. `opencode.json` (untracked) survived — `reset` does not touch
untracked files.

The edits were **never staged**, so git created no blob for them → **unrecoverable via
git** (no dangling blob, no reflog entry; the only dangling blobs were the agent's own
intermediate `git add`s of source files). Recovery path is the editor's local history
(VSCode Timeline / JetBrains Local History), not git.

## Why the standard advice misled

The next-session handoff said: *"`git push origin main` after a squash-merge FAILS
fast-forward; `git fetch` then `git reset --hard origin/main` (your work is in the squash,
nothing lost)."* That is true **only for a CLEAN working tree** — when the ONLY divergence
is the just-squashed commit. It is **wrong** when the tree also holds someone else's
uncommitted work, which `reset --hard` silently destroys.

## The rule

On a shared working tree that may carry the operator's (or anyone's) uncommitted changes,
**never `git reset --hard`** to sync a branch. Instead:

- `git pull --ff-only origin main` — a fast-forward that **REFUSES** (non-zero, no
  mutation) if the local branch has diverged, so you notice instead of clobbering; or
- `git stash` the foreign changes first, sync, then `git stash pop`; or
- simply `git fetch` and rebase your own commits, leaving the working tree untouched.

`reset --hard` is a last resort reserved for a tree you KNOW is disposable. Before any
`reset --hard`/`checkout -- .`/`clean -fdx` on a shared tree, run `git status` and account
for every `M`/`??` entry — if any is not yours, do not run it.

This is a specific instance of the general "look at the target before you overwrite it"
rule: the three files were explicitly flagged as the operator's in the handoff, and the
`git status` at session start showed them as `M`.

## Related

- [[harness-on-real-repo-prerequisites]] — the "tree must be clean or the merge throws" family (a clean tree is load-bearing, but cleaning it must not eat foreign work).
- `AGENTS.md` — git-ownership: the agent drives all git, which makes "don't destroy the operator's uncommitted files" a hard constraint, not a nicety.
