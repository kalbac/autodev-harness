# `[usage/type-strip-not-runtime-strip]` — removing a field from a TS type does not strip it from a persisted runtime object

**Found:** s25 (codex gate on the cost-strip), `src/usage/usage.ts` `buildTokenUsageDoc`.

## The trap

The operator wanted "NO cost anywhere" in the token telemetry. We deleted `total_cost_usd`
from `WorkerUsage`, `TokenUsageDoc`, and every builder/guard. `tsc` went green — the compiler
no longer *sees* a cost field anywhere. It looks done.

But `buildTokenUsageDoc` persisted the per-run detail arrays **by reference**:

```ts
const worker = { /* summed totals */, runs: workerRuns };   // <-- workerRuns passed straight through
// ...
await repo.writeRuntimeFile(task.id, "token-usage.json", JSON.stringify(doc, null, 2));
```

`JSON.stringify` serializes the **actual runtime shape** of the object, not its static type. A
`WorkerUsage` value that still carries a `total_cost_usd` property at runtime (a legacy object, an
enriched input, a future adapter that forgot the rule) would have its cost written straight into
the artifact — invisible to `tsc`, invisible to a type-only review, surfacing only in the file on
disk. "The type doesn't have the field" ≠ "the field can't be written."

## The rule

When a persisted artifact must NOT contain a field, strip it at the **write boundary**, not just
from the type. Rebuild the object with an explicit field pick before serialization:

```ts
const workerRunCopies: WorkerUsage[] = workerRuns.map((r) => ({
  model: r.model,
  input_tokens: r.input_tokens,
  output_tokens: r.output_tokens,
  cache_read_input_tokens: r.cache_read_input_tokens,
  cache_creation_input_tokens: r.cache_creation_input_tokens,
}));
```

This makes "the artifact contains no cost" a **structural guarantee of the writer**, independent of
every upstream constructor staying clean. Regression-test it by injecting a stray field on the input
and asserting `JSON.stringify(doc)` carries no `/cost/i` substring — a type-level test can't catch a
runtime-only leak.

Note the asymmetry with **validation**: `isTokenUsageDoc` deliberately *ignores* an extra
`total_cost_usd` on a legacy on-disk doc (backward-compat — reading old files must not fail). Reading
tolerates the stray field; writing must never emit it. Tolerant-in, strict-out.

## Related
- `[[per-round-overwrite-artifact-stale]]` — the sibling conductor-artifact write-discipline gotcha (s24).
- `[[never-throws-catch-block-logging]]` — the `token-usage.json` writer is best-effort/never-throws.
