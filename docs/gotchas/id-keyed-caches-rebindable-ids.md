# Id-keyed caches over re-bindable ids: EVERY cache needs binding validation

**Tag:** `[multiproject/id-keyed-caches]` · **Found:** s16 (codex R1 f2/f5 + R2 both findings) · **Where:** `src/hub/hub.ts`, `src/api/server.ts`

## The mistake

The multi-project daemon keys runtime state by project id, but an id is **re-bindable**:
the registry can be edited (or, post-M3, a project unregistered and re-registered) so the
same id points at a different path. THREE separate id-keyed caches each turned stale
independently, and each needed its own fix across two critic rounds:

1. **Hub `roots`** (`Map<id, Promise<Root>>`) — served/orchestrated the WRONG repo after
   a path change. Fix: store the built-for path in the record; on `get()`, path mismatch
   → invalidate + rebuild; `list()` reports "ready" only on path equality.
2. **Server `watchers`** (`Map<id, watcher>`) — old-path watcher kept broadcasting under
   the reused id; new path never watched. Fix: store stateDir with the handle; reattach
   on mismatch **and identity-guard the callback** (`if (watchers.get(id) === record)`)
   because the stale handle's fire-and-forget `close()` may never settle.
3. **Hub `lastError`** (`Map<id, string>`) — a moved project inherited the OLD path's
   error in `list()`. Fix: store the path with the error; report only on match.

## The rule

In any system where an id can be re-bound to a different resource, an id-keyed cache
entry must carry **what it was built for** (the binding) and validate it on every hit.
Fixing one cache does not fix the others — enumerate ALL id-keyed state (`grep` the map
declarations) and audit each: roots, watchers, error memos, single-flight sets (ours was
safe only because orchestrate runs are short-lived). For callbacks that outlive their
registration (fs watchers, subscriptions), an identity guard at fire time beats relying
on `close()` having worked.

## Related

- `docs/gotchas/shared-inflight-promise-rejection.md` — sibling hub-cache gotcha, same review.
- `src/hub/hub.ts` (`7112cd5`, `3aeb407`), `src/api/server.ts` (`164aa19`, `d39dd48`).
