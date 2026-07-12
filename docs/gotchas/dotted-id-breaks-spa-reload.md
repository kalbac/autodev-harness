# `[ui/dotted-id-breaks-spa-reload]` — a URL path segment with a dot (slugified filename) 404s the SPA on reload/direct-nav

**Found:** s40 live-prove (browser).

## What happened

Thread ids are minted from the operator intent via `slugifyIntent`, which KEEPS dots (`[api/run-id-dot-validation-mismatch]`). An intent naming a file — "Add a docs/**FAQ.md** ..." — produces a thread id like `Add-a-docs-FAQ.md-with-...`. The client route is `/p/:id/t/:threadId`. Clicking a thread link INSIDE the loaded app works (TanStack Router does client-side navigation, no server round-trip). But a **reload or direct-paste** of `/p/s40-demo/t/Add-a-docs-FAQ.md-...` hits the daemon's static server, whose SPA-fallback treats the dotted last segment as a FILE request (it has a `.md`-looking extension), does not fall back to `index.html`, and returns the API `{"error":"not found"}` JSON instead of the app. Confirmed live: `curl /p/.../t/<dotted-id>` → 404; the same page with a dot-free id → 200 `text/html`.

## Fix (s40, contained) + the root fix (deferred)

- **s40 fix (contained to the feature):** `mintThreadId` in the composition strips dots after slugifying (`slugifyIntent(intent).replace(/\./g,"-").replace(/-+/g,"-").replace(/^-+|-+$/g,"")`), so thread URLs never contain a dotted segment. Live-verified: dot-free id → HTTP 200 on direct nav.
- **Root cause (still open, backlog):** the static SPA-fallback only serves `index.html` for extensionless paths. **Run ids and task ids ALSO keep dots** (`run-...-OVERVIEW.md-...`), so a reload/direct-nav of `/p/:id/runs/<dotted-run-id>` or `/tasks/<dotted-id>` has the same 404 (within-app clicks are fine — client routing). The proper fix is the static handler: serve `index.html` for any non-existent, non-`/assets/` path (regardless of a dot), keeping the `[api/static-traversal]` realpath containment. Deferred — touches the shared, security-sensitive static handler.

## Rule
Any value that becomes a URL PATH SEGMENT and is derived from free text (slugs of filenames, intents) must be dot-free, OR the SPA-fallback must be extension-agnostic. Test a RELOAD, not just an in-app click — client routing masks the server-side 404.

## Related
- `[api/run-id-dot-validation-mismatch]` — slugifyIntent keeps dots (the source of the dotted id).
- `[api/static-traversal]` — the static handler + SPA-fallback (cross-platform lexical) that must be touched for the root fix.
