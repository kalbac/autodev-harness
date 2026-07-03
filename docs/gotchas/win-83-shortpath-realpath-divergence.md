# `[ci/win-83-realpath]` — Windows 8.3 short paths: `fs.realpathSync` ≠ `fs.promises.realpath`

**Tag:** `[ci/win-83-realpath]`
**Where:** `src/fsbrowse/fsbrowse.ts`, `src/registry/admin.ts` (`isRegistered`/`register`), any test that builds a tmp path and compares it to a path the code canonicalized. Surfaced s17 (M3), only on the GitHub `windows-latest` runner.

## The trap

The GitHub Windows runner exposes `os.tmpdir()` as an **8.3 short path**: `C:\Users\RUNNER~1\AppData\Local\Temp`. Two "realpath" APIs disagree on whether they expand it:

- `fs.promises.realpath(p)` (and `fs.realpathSync.native`) → the **native** libuv realpath → **expands** 8.3 to the long form: `C:\Users\runneradmin\...`.
- `fs.realpathSync(p)` (the non-native JS implementation) → resolves `.`/`..`/symlinks but **leaves the 8.3 alias in place**: `C:\Users\RUNNER~1\...`.

So a test that seeds `base = realpathSync(mkdtempSync(...))` (short form) and asserts it equals what the code returns via `fs.promises.realpath` (long form) **fails only on the runner** — and passes on any dev box whose user profile has no 8.3 alias (most do not). Green locally, red on CI, with a baffling `expected 'C:\Users\runneradmin\…' to be 'C:\Users\RUNNER~1\…'`.

## Two distinct failures it caused

1. **Test-only:** `fsbrowse.test.ts` compared `res.path`/entry paths (native-realpath'd by `listDirs`) against a `realpathSync`-seeded (non-native) `base`. Fix: seed the test base with `realpathSync.native(...)` so it matches the code's native realpath.
2. **Production:** `admin.register` stored `realpath(path)` (native, long) but `admin.isRegistered(p)` compared the RAW `p` via `isPathRegistered` (`resolve` + case-fold, NOT realpath) — an 8.3/symlinked/un-normalized argument never matched the stored canonical path. Fix: `isRegistered` must `realpath`-canonicalize its argument the SAME way `register` does before comparing (fall back to the raw path when realpath fails, e.g. a since-deleted entry). The "reflects membership by canonical path" test asserts exactly this.

## Rule

- When code canonicalizes with `fs.promises.realpath` (or `.native`), tests must canonicalize the **same way** — use `realpathSync.native`, never the plain `realpathSync`, to build comparison paths.
- A function that MATCHES against a stored canonical path must canonicalize its input **identically** to whatever wrote the stored value. Store-side `realpath` + query-side `resolve` is a latent mismatch that only bites under 8.3/symlink aliasing.
- CI must include a real `windows-latest` job — this class is invisible on a normal dev Windows box.

## Related
- [[id-keyed-caches-rebindable-ids]] — the other registry-canonicalization pitfall (path-keyed caches).
- [[win-git-worktree-remove-follows-junction]] — the other Windows-reparse-point gotcha.
