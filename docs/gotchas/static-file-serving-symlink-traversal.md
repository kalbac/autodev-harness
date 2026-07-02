# `[api/static-traversal]` — static file serving: lexical + `O_NOFOLLOW` are NOT enough; need realpath containment

**Tag:** `[api/static-traversal]`
**Where:** `src/api/server.ts` static UI-bundle serving (`resolveStaticPath` / `tryServeStaticFile`, P2 dashboard module 3, s13).

## The trap

Serving files from a directory (`uiDir`) with only (a) a **lexical** guard (decode → reject `..`/NUL/`\`/`:` segments → `path.resolve` + prefix check) and (b) a **final-component** no-follow open (`lstat` + `isFile` + `O_NOFOLLOW`) still lets an **INTERMEDIATE symlink directory** escape:

```
uiDir/assets  ->  /outside          (assets is a symlink dir)
GET /assets/secret.js
  lexical check:  resolves under uiDir  ✓ (passes)
  lstat(uiDir/assets/secret.js):  follows the `assets` symlink, sees a regular file  ✓ (passes)
  O_NOFOLLOW:  only guards the FINAL component (`secret.js`), NOT `assets`
  => serves /outside/secret.js   ✗ ESCAPE
```

`O_NOFOLLOW` and a leaf `lstat` only ever protect the last path segment. A symlinked *ancestor* sails through both.

## The fix (what we did)

**`realpath` containment:** canonicalize `uiDir` once (`realpathSafe`), then after `lstat`+`isFile` on the target, `realpath` the target and re-verify `canonical === canonicalUiDir || canonical.startsWith(canonicalUiDir + sep)`; open the canonical path. This resolves ALL symlinks (intermediate included) before the containment check. This is exactly what the industry `serve-static` lineage does.

## Accepted residual (documented in code)

A `realpath` → `open` gap remains: a concurrent adversary could swap an intermediate dir to a symlink between the `realpath` and the `open`. **Fully closing it needs per-component no-follow resolution (`openat2` `RESOLVE_BENEATH`), which Node exposes on no platform portably.** Accepted for this threat model — a **localhost, single-operator, no-auth daemon serving its OWN build output** (`<repoRoot>/dist/ui`); such an adversary already has same-user FS access. codex-confirmed acceptable.

## Related sibling traps (same module, s13)

- **SPA-fallback heuristic must be cross-platform lexical, not errno.** `/assets/app.js/foo` (a path *under* a file) is `ENOTDIR` on POSIX but `ENOENT` on Windows — an errno-based "missing → fall back to index.html" wrongly serves 200 on Windows. Fix: fall back only when NO segment of the resolved-relative path has a file extension (pure lexical, OS-agnostic). Same check fixes `/missing%2ejs` (encoded dot) since it runs on the DECODED path.
- **Truncated ≠ the file's content-type.** An over-cap file served with a truncation marker is no longer valid JSON — serve it `text/plain` + `x-truncated`, never `application/json`. Binary assets are REFUSED (never truncated), text runtime files ARE truncated.

## Related

- [[harness-on-real-repo-prerequisites]] — other real-world api/fs surprises.
- Design: `docs/superpowers/specs/2026-07-02-p2-dashboard-design.md`.
