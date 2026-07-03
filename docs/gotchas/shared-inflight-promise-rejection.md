# Shared in-flight Promise: EVERY awaiter needs its own rejection handling

**Tag:** `[ts/shared-promise-reject]` · **Found:** s16 (codex R1 finding 1, HIGH) · **Where:** `src/hub/hub.ts`

## The mistake

Caching an in-flight `Promise` so concurrent consumers share one build:

```ts
const cached = roots.get(id);
if (cached) return { root: await cached };   // ← BUG: bare await
// ...
const building = deps.buildRoot(entry);
roots.set(id, building);                      // set BEFORE await (correct)
try { return { root: await building }; } catch (err) { /* -> {error} */ }
```

Only the FIRST caller (the one that created the promise) awaits inside a try/catch. A
second concurrent caller takes the `cached` branch and awaits BARE — when the shared
build rejects, that caller's rejection escapes the function. In our API server the
generic handler turned it into a 500, while the sibling request correctly got the
`{error}` → 503 path. Nondeterministic per-caller behavior for the same failure.

## Why the tests missed it

The hub had a concurrent-get test — but only for the SUCCESS case. The concurrent
**failure** case is the blind spot: sharing a promise means sharing its rejection with
every awaiter, and each await site is a separate escape hatch.

## The rule

When a `Map<key, Promise<T>>` is used to share in-flight work, wrap **every** `await`
of the cached promise in the same rejection handling as the creator's, and on cleanup
mutate the cache only if it still holds *your* promise (`if (map.get(k) === cached)`)
— a concurrent retry may already have replaced it. Test matrix must include:
concurrent success, concurrent FAILURE (all callers get the error result, none reject),
and retry-after-failure.

## Related

- `docs/gotchas/id-keyed-caches-rebindable-ids.md` — the sibling cache-lifecycle gotcha from the same review.
- `src/hub/hub.ts` — the fixed implementation (`46fe791`).
