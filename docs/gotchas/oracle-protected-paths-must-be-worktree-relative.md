# `[gate/oracle-protected-paths-relative-invariant]` — a protected path resolved at one root and enforced at another

**Tags:** `[gate/oracle-protected-paths-relative-invariant]`
**Found:** s50 (2026-07-22), building `adr/006` Phase 2.

## The shape of the trap

`adr/006` Phase 2 declares the protected oracle set (`src/gate/oracle-paths.ts`)
by reading the **trusted root** (`repoRoot`), and then *enforces* it by
fingerprinting those paths inside the **per-task worktree**:

```ts
snapshot(wt.path, oracleSet.literals)   // -> join(wt.path, entry)
```

Two different roots, one list of strings between them. Everything below is a
consequence of that: **the declaration is only enforceable if every entry is
worktree-RELATIVE, `/`-separated, and names a real regular file.** It took
**six** codex `gpt-5.6-luna` rounds to state that invariant correctly, each round
finding a narrower leak inside the previous round's own fix.

The failure direction is the nasty one: a protected path that fails to resolve is
not an error, it is a path that **silently protects nothing** — the fingerprint
reads the same value before and after the worker, so no drift, no escalation, and
the operator believes the file is guarded.

## The six leaks, in the order they were found

1. **Absolute entry.** Passed trusted-root containment, but `path.join` does NOT
   discard an absolute second argument the way `resolve` does — it concatenates
   (`join('D:/wt', 'D:/repo/x')` → `D:/wt/D:/repo/x`). Result: `"<absent>"` before
   and after. Fixed by refusing absolute entries outright on every platform.
2. **Swallowed containment error.** One `try/catch` wrapped both `lstat` and
   `realpathContains`, re-throwing by matching the error's *message prefix* — so an
   fs error from the containment probe read as "file not created yet" and the entry
   joined the set unproven. Fixed by scoping the `try` to `lstat` alone.
3. **Bare `catch` on `lstat`.** Folded `EACCES`/`ELOOP`/`EIO` into "absent", same
   swallow one level narrower. Fixed with an errno allowlist: only `ENOENT`/`ENOTDIR`
   mean absent; every other code fails closed.
4. **Empty normalized key.** An entry resolving to the repo root (`.`, `docs/..`)
   normalizes to `""`, and `snapshot` **skips empty paths outright** — accepted, and
   protecting nothing. Fixed by refusing it with its own message.
5. **Host-only absolute detection.** `path.isAbsolute` is the HOST implementation,
   so on POSIX every Windows form (`D:\x`, `D:x`, `\\server\share\x`, and the
   lone-backslash `\foo`) read as an ordinary relative path. This is a
   cross-platform product — a config authored on Windows is legitimately loaded by a
   daemon on Linux. Fixed with `isAbsolute(e) || win32.isAbsolute(e) || /^[A-Za-z]:/`.
6. **Separator folding applied inconsistently.** `path.resolve`/`lstat` on POSIX
   treat `\` as an ordinary filename byte, so `docs\GUARDS.md` probed a file
   literally named `docs\GUARDS.md` (a miss) while still emitting the `/`-joined key.
   Fixed by folding `\`→`/` *before* resolve/probe — in **both** probe paths
   (`normalizeLiteralEntry` and `resolveTrustedFile`), which is where it was first
   applied to only one.

Plus two hardenings from the same invariant: a **symlinked leaf** is refused
(`snapshot` follows the link and hashes the *target*, so repointing the link would
not register as drift), and so is a **directory** or any **special file**
(FIFO/socket/device) — a directory reads `"<unreadable>"` both before and after, so
it can never register a change; a whole subtree is declared with the glob arm.

## Rules to carry forward

- **A path resolved against one root and consumed against another needs an explicit,
  stated normal form.** Write the invariant down (`worktree-relative, /-separated,
  names a real regular file`) and enforce it at the single point of entry, rather than
  patching each symptom as a critic finds it. Five of the six rounds were the same
  invariant restated.
- **`join` and `resolve` differ on absolute second arguments**, and only `resolve`
  discards the root. A containment check written against `resolve` does not license
  a later `join`.
- **Never fold a "could not determine" into a "no".** Both swallow bugs (#2, #3)
  read an inconclusive probe as a benign absence. Use an errno allowlist and let
  everything else fail closed (Principle 10).
- **`normalizePath` is for set-comparison, never for path construction or escape
  checks** — it strips leading `.`/`/` (PowerShell `.TrimStart('./')` parity), which
  turns `../shared/**` into `shared/**` (erasing the escape being checked) and
  `.github/workflows/ci.yml` into `github/workflows/ci.yml`.
- **Cross-platform means "not the host implementation".** Any `path.*` predicate
  applied to operator-authored config must consider the *other* platform's syntax.

## The live proof also found a reporting defect

A file caught by BOTH arms (a declared literal AND a declared glob) produced two
evidence lines and `modified 2 oracle artifact(s)` for a single edit, one of them
showing the `normalizePath`-stripped path. Unit tests were green — each arm was
correct in isolation. Fixed by `mergeOracleHits` (dedupe on `normalizePath`, display
the literal arm's undistorted spelling, accumulate kinds → `fs-fingerprint+glob`).
**Overstating one edit as two is exactly the unearned claim Principle 13 forbids in
our own artifacts** — and only a live run showed it.

## Related

- `docs/adr/006-capability-based-authority-model.md` — Phase 2 consequence.
- `gotchas/oracle-definitions-trusted-root-behavior-changes.md` — Phase 1's siblings.
- `gotchas/static-file-serving-symlink-traversal.md` — the realpath-containment precedent.
- `gotchas/win-83-shortpath-realpath-divergence.md` — the other cross-platform path trap.
- `docs/PRINCIPLES.md` — #10 (fail toward the safe state), #13 (evidence, not assertion), #14 (the worker does not write its own oracle).
