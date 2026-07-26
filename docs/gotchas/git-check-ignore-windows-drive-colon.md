# `[git/check-ignore-windows-drive-colon]` — a Windows absolute path is unusable as a git pathspec

> Found s58 (2026-07-26), on the FIRST real corpus run after s57 shipped the
> diagnostics layer. Issue #135.

## The behaviour

Git pathspecs treat a leading `:` as **magic** (`:(literal)`, `:/`, `:!`). A Windows
absolute path carries a colon in position 2, so git parses the drive letter as a magic
prefix and dies:

```
$ git check-ignore D:\Projects\wordpress\woodev-shipping-plugin-test\.autodev\corpus-artifacts
fatal: D:\...\corpus-artifacts: pathspec magic not supported by this command: 'literal'
(exit 128)
```

This is not a weird-repository problem. It is unconditional on Windows, for every
absolute path, in every git version that supports pathspec magic.

## Why it hid until a real run

`assertArtifactsRootSafe` (`src/eval/artifacts-root.ts`) asks `git check-ignore`
whether the corpus's artifacts directory is excluded, because artifacts written into a
tracked location would dirty the target tree and change the very measurement they
exist to explain. The module is careful and fail-closed by design: an unanswerable
safety question is a refusal, not a pass. So when git returned 128 it refused, exactly
as written.

The result was that the check **could never answer on Windows**, and the diagnostics
feature s57 spent seven critic rounds on could never run with its default artifacts
path on the platform it was built on. Its unit tests passed because none of them used
a path with a drive letter — the fixtures were POSIX-shaped, so the tests exercised a
string form the production caller never produces.

Workaround used to get the s58 measurement: `--artifacts <dir outside the repo>`.

## The rules

1. **Never hand a Windows absolute path to a git command that takes a pathspec.**
   Prefer a repo-relative path (`check-ignore` is asking about something inside the
   repo anyway, so relative is both correct and colon-free). If an absolute path is
   unavoidable, force literal parsing (`--literal-pathspecs` / `GIT_LITERAL_PATHSPECS=1`),
   and *measure* that it works rather than assuming.
2. **A cross-platform product needs a path-shaped test fixture from every platform it
   claims to run on.** This is the same lesson as `win-83-shortpath-realpath-divergence.md`
   and `oracle-protected-paths-must-be-worktree-relative.md` (where `path.isAbsolute` was
   the HOST implementation): a path string is platform data, and a POSIX-only fixture
   silently proves nothing about Windows.
3. **A fail-closed check that always fails is not safe, it is broken.** Refusing was the
   correct direction, and it still made a shipped feature unreachable. When a guard
   refuses, check whether it *can* ever pass on this platform before concluding the
   guard is fine.

## Related

- `win-83-shortpath-realpath-divergence.md` — the other Windows path-shape divergence.
- `oracle-protected-paths-must-be-worktree-relative.md` — `path.isAbsolute` is the host
  implementation; a cross-platform product cannot use it to judge foreign path shapes.
- `agent-ci-not-runnable-on-native-windows.md` — the other "this feature cannot run on
  the operator's own platform" finding.
