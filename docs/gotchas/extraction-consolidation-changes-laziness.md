# A "pure mechanical extraction" that consolidates call sites can change laziness

**Tag:** `[refactor/extraction-eagerness]` · **Found:** s16 (codex R1 finding 3, HIGH) · **Where:** `src/composition/root.ts`

## The mistake

Extracting `main()`'s wiring into `buildProjectRoot()`, we consolidated two IDENTICAL
`buildOrchestrator(...)` call sites (the `serve` and `orchestrate` branches) into one
call inside the factory — "same args, called once, exposed as `root.orchestrator`".
Looks like deduplication; it is actually an **eagerness change**: the `run` verb never
called `buildOrchestrator` before, and `buildOrchestrator` THROWS for an unregistered
`roles.orchestrator.adapter`. Post-extraction, `autodev run` failed on configs that
used to work (valid worker/critic, non-`claude` orchestrator adapter — the roles schema
accepts any adapter string and `assertKnownAdapters` checks worker/critic only).

## The rule

"Behavior-identical extraction" must preserve **when** things are constructed, not just
**what**. Consolidating N call sites into a shared field makes the construction eager
for ALL consumers of the shared object, including consumers that never used it. If any
constructor can throw (adapter registries, config-dependent switches), consolidate into
a **memoized lazy getter** instead:

```ts
let orchestrator: Orchestrator | undefined;
const get = () => (orchestrator ??= buildOrchestrator(ctx));
return { orchestrator: { handleIntent: (i) => get().handleIntent(i) } };
```

When reviewing an extraction diff, diff the *initialization graph* (who constructs what,
on which code path), not just the moved lines.

## Related

- `docs/gotchas/conductor-wiring-deferred-limitations.md` — composition-root testing status (untested glue).
- `src/composition/root.ts` — the lazy fix (`3634104`) + `src/composition/root.test.ts` (laziness pinned).
