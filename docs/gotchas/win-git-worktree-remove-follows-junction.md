# Gotcha — `git worktree remove` FOLLOWS an NTFS junction on Windows (recursive target deletion)

**Tag:** `[worktree/win-junction-follow]` · **Found:** s15 (2026-07-03), building deps-provisioning (Finding #1). Verified 6/6 deterministically (in-test + standalone repro) + codex-confirmed.

## The trap

Deps-provisioning links gitignored dep dirs (`vendor`, `plugins-reference`) into each per-task
worktree as **directory junctions** (Windows) / dir-symlinks (POSIX). When the conductor later
tears the worktree down, `git worktree remove [--force]` and Node `rm(path, {recursive:true})`
do a recursive delete of the worktree dir. On **Windows/Git-for-Windows, `git worktree remove --force`
FOLLOWS a junction and recursively deletes the junction's REAL TARGET's content** — i.e. it can
wipe the clone's real `vendor/` (or, for a foreign junction, arbitrary external data the link
points at). `lstat().isSymbolicLink()` is `true` for our junctions here, but that doesn't help
git's own recursive walk.

This is NOT hypothetical — it reproduced 6/6. The naive "provision a junction, let teardown
remove the worktree" loses the real deps on the first teardown.

## The rule (how the harness stays safe)

**Link-only-remove EVERY top-level reparse point BEFORE any recursive worktree removal.** Never
let git / `rm -rf` reach a live junction.

- `removeLinkOnly(link)`: `lstat`; only if `isSymbolicLink()`; `unlink` then **non-recursive**
  `rmdir` (a populated real dir → `ENOTEMPTY` → left intact); re-`lstat` to CONFIRM gone; returns
  a boolean. It **never recurses** and never follows into a target.
- `deprovisionWorktree(wtPath)`: a **non-recursive top-level scan** — removes **every** top-level
  symlink/junction (ours, stale, or foreign; a live junction is dangerous no matter who made it),
  and returns `false` if any could not be confirmed removed.
- Callers gate on it: `teardown` **early-returns (leaves the worktree)** if deprovision returned
  false; `create()`'s re-queue stale-cleanup **throws** before `git worktree prune`/`remove --force`/
  `rm(recursive)`. Refusing to recurse is the fail-safe — a leftover worktree is retryable; deleted
  real deps are not.
- Provisioning identifies "ours" by target signature (`readlink === join(repoRoot, name)`) **only to
  label logs**, NOT to gate removal (signature-gating was proven data-loss-unsafe: leaving a foreign
  junction lets git follow it).
- **Provision entries are restricted to a single top-level segment** (config `superRefine` +
  `isSafeProvisionEntry` reject `/`, `\`, `.`, `..`, absolute) so all OUR links are top-level and the
  non-recursive scan is complete. Nesting was YAGNI and was the source of a "nested stale link"
  data-loss gap.

## Residual (documented, accepted)

A **nested FOREIGN reparse point** (a junction a user/tool creates deeper than the worktree top
level — the harness never makes one) is outside the top-level scan and could still be followed by
`git worktree remove`. This is **pre-existing Git-for-Windows behavior, not introduced by
deps-provisioning**. Fully closing it would require replacing git's recursive delete with a custom
non-following remover (out of scope). High impact, foreign-triggered, low likelihood — ship + document.

## Why 4 critic rounds

The safety model converged through the codex gate: signature-record (manifest) → rejected as
best-effort → filesystem ground-truth scan → the junction-follow discovery forced strip-**all**
top-level (not just "ours"). Each round closed a real, reproduced data-loss path. See the s15
SESSION-LOG entry.

## Related

- `docs/gotchas/harness-on-real-repo-prerequisites.md` — `[conductor/real-repo-run]` (fresh worktree lacks gitignored deps → Finding #1, the reason provisioning exists).
- `docs/gotchas/runnative-windows-cmd-shim-spawn.md` — another Windows-fs/spawn gotcha.
- `docs/superpowers/specs/2026-07-02-p3-deps-provisioning-design.md` + `docs/superpowers/plans/2026-07-02-p3-deps-provisioning.md`.
