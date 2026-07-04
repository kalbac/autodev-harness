# `[scaffold/config-file-symlink]` — a config-write path must lstat the FILE, not just its parent dir

## The mistake

`admin.updateConfig` (s19, the `PATCH /projects/:id/config` write path) copied
`scaffoldProject`'s existing symlink guard — `lstat(".autodev")`, refuse if
it's not a real directory — and stopped there. That guard is sufficient for
`scaffoldProject` (which recursively `mkdir`s a whole skeleton and needs to
refuse a hostile `.autodev -> /outside` link at the top), but it is NOT
sufficient for a single-file update: `.autodev` can be a perfectly real
directory while `.autodev/config.yaml` INSIDE it is a symlink to an external
file. `readFile`/`writeFile` follow that symlink transparently, so the
"safe" directory check gave false confidence while the actual read+write
would have silently read from and overwritten an arbitrary file outside the
repo.

## The fix

`lstat` the **file path itself** (`config.yaml`), not just its parent
directory, before either reading or writing it. If it exists and
`!lstat(...).isFile()`, refuse with a typed `invalid_config` error
mentioning "symlink" — same error code as the directory-level guard, no new
error taxonomy needed. Regression test: create a real `.autodev` dir, drop a
symlink at `.autodev/config.yaml` pointing at an external file with known
content, call `updateConfig`, assert the typed refusal AND that the external
file's content is untouched.

## Accepted residual (documented, not fixed)

A classic TOCTOU window remains between the `lstat` check and the subsequent
`readFile`/`writeFile`/`mkdir` — a local process could swap the path after
the check passes. For a single-operator local daemon (not a hostile
multi-tenant service) this is an accepted residual, the same risk-acceptance
posture already documented for `[api/static-traversal]`'s realpath→open gap.
A hostile multi-tenant deployment would need an fd-based/no-follow open
strategy instead.

## Lesson for future symlink guards

When adding a write path that goes through an existing directory whose
symlink-safety was already vetted for a DIFFERENT write shape (a recursive
skeleton write vs. a single named file write), re-derive which path segments
actually need guarding for the NEW write's specific shape — don't assume the
existing directory-level guard transfers unchanged. Ask "what is the exact
path the write touches, and is every segment of it checked?"

## Related
- `gotchas/scaffold-symlink-escape.md` — the original `.autodev`-directory guard this one extends
- `gotchas/hub-cache-must-evict-on-external-config-write.md` — the other finding from the same codex review round
