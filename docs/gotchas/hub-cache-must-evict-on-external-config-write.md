# `[hub/evict-on-config-write]` — a config-write endpoint must evict the hub's cached ProjectRoot

## The mistake

`createProjectHub` builds and caches ONE `ProjectRoot` per project id on first
`get()` — the cached root carries the already-loaded `HarnessConfig` (gate,
roles, worktree provisioning, everything `conductor.run` uses). Adding a
config-WRITE endpoint (`PATCH /projects/:id/config`, s19) that only writes
`.autodev/config.yaml` to disk, without also invalidating the hub's cache,
would leave the LIVE daemon running the OLD config indefinitely — the write
looks like it succeeded, but the gate/critic/worker behavior never changes
until the daemon restarts. This directly undermines the project's core
guarantee ("never let them merge bullshit"): an operator who tightens the
gate command or role config through the UI would silently keep running the
looser one.

## The fix

`ProjectHub<R>` gained a synchronous `evict(id)` method (`roots.delete(id);
lastError.delete(id);`). The composition root (`index.ts`) wraps
`admin.updateConfig` so a **successful** write calls `hub.evict(id)`
immediately after — the NEXT `hub.get(id)` (e.g. the same request's own
post-write re-resolve for its HTTP response) rebuilds from the fresh file.

Keep `admin.ts` (the registry mutation layer) **hub-agnostic** — it only
knows about `registry.json`/`.autodev/config.yaml`, never the hub. Wire the
cross-cutting invalidation at the composition root, mirroring how `DELETE
/projects/:id`'s watcher teardown already lives in `server.ts`, not in
`admin.ts`.

## A related false-positive to not chase

A first-pass codex review claimed `evict()` was insufficient because an
ALREADY in-flight `hub.get()` build (started before the evict) could "resolve
later and get stored back into `roots`". Reading the full `get()`
implementation disproves this: `roots.set(id, record)` happens ONCE,
synchronously, BEFORE the `await` — the success path never re-writes the map
after the promise resolves. Evicting mid-build removes the in-flight record;
when it later resolves it only returns its result to whichever caller was
already awaiting it directly, never touching the map again. A fresh `get()`
call issued after the evict starts an entirely new record and correctly
rebuilds from the current file. Re-verified with codex on re-review with an
explicit call-sequence walkthrough — confirmed not reproducible. Lesson: when
a critic's tool calls to inspect the surrounding (unchanged) code all fail
silently (sandbox errors, no repo access), it may reason abstractly from a
diff-only view and produce a plausible-sounding but non-reproducing claim —
verify against the actual control flow before "fixing" it.

## Related
- `gotchas/config-write-must-guard-the-file-not-just-its-parent-dir.md` — the other finding from the same codex review round
- `docs/CURRENT-STATE.md` — s19 config-write endpoint entry
