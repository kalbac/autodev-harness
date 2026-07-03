# `[scaffold/symlink-escape]` — scaffolding `.autodev/` follows a symlinked target OUT of the repo

**Tag:** `[scaffold/symlink-escape]`
**Where:** `src/registry/scaffold.ts` (`scaffoldProject`). Found by the codex gate (M3, s17), HIGH; fixed + re-critic clean after a second (narrower) residual.

## The trap

`scaffoldProject(repoRoot, ...)` writes a skeleton with `mkdir`/`writeFile` under `join(repoRoot, ".autodev", ...)`. Both **follow symlinks**. A repo checked out / cloned with a hostile reparse point makes the whole skeleton land OUTSIDE the target repo:

- `.autodev -> /outside` (the dir itself is a symlink): `existsSync(configPath)` follows it (config absent at target → skip check passes), then `mkdir(.autodev/queue/…)` / `writeFile` create the queue dirs + stubs + `config.yaml` in `/outside`.
- `.autodev/queue -> /outside` (a symlinked CHILD of a real `.autodev/`): `mkdir(.autodev/queue/pending, {recursive})` follows the child link and creates `/outside/pending`.

Threat model: not an active local attacker (single-operator localhost tool), but a **static hostile checkout** causing unexpected out-of-repo writes.

## The fix (two layers, both needed)

At the TOP of `scaffoldProject`, BEFORE the config-skip check and any write:

1. `lstat(.autodev)` (describes the link, never its target). If it exists and is **not a real directory** (symlink/junction/file) → throw `ScaffoldConfigError` (→ 400 `invalid_config`, not a 500).
2. If `.autodev` IS a real directory → `readdir(withFileTypes)` and throw on **any symlinked direct child** (closes `.autodev/queue -> /outside`).

Deeper grandchildren are deliberately NOT scanned — the only ops below a verified-real child are recursive `mkdir` on the fixed queue/state dirs (mkdir on an existing symlinked leaf is a no-op, never an out-of-repo content write) and the stubs/config written `wx`/`O_EXCL` (which refuses to follow a final symlink). Verified clean by re-critic.

## Rule

Any code that writes a fixed directory tree under a caller-supplied root must `lstat`-guard the tree's ROOT and its direct children against reparse points before the first `mkdir`/`writeFile` — `existsSync`/`stat` follow links and give a false "safe" reading. `wx`/`O_EXCL` protects only the FINAL component of a written file, not intermediate dirs a recursive `mkdir` walks.

## Related
- [[static-file-serving-symlink-traversal]] — same class on the READ side (intermediate symlink dir escapes `uiDir`); realpath-containment there, lstat-refuse here.
- [[win-git-worktree-remove-follows-junction]] — reparse points followed on teardown.
