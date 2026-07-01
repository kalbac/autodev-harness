# Gotcha: zod `.optional()` + `exactOptionalPropertyTypes` — derive types, don't hand-write

**Tag:** `[ts/zod]`
**First hit:** s05 (2026-07-01), `src/gate/invariants.ts` Task 15.

## Symptom

A module pairs a hand-written interface with a zod schema (the `src/critic/verdict.ts`
pattern). Vitest is green, but `npm run typecheck` fails with:

```
error TS2322: Type '{ ...; constitution: { path_globs: string[]; why?: string | undefined } }'
  is not assignable to type 'Invariants'.
    Type 'string | undefined' is not assignable to type 'string'.
```

## Why

With `exactOptionalPropertyTypes: true` (our tsconfig), a hand-written `why?: string`
means "absent, or a `string`" — it does NOT permit an explicit `undefined`. But zod's
`z.string().optional()` infers `why?: string | undefined`. So `schema.safeParse(...).data`
is not assignable to the hand-written interface. `verdict.ts` sidesteps this only because
its optional field (`diff_sha256`) is absent from the schema entirely, so `result.data`
lacks the key rather than typing it `| undefined`.

## Fix

Make the zod schema the single source of truth and DERIVE the exported types:

```ts
export type ContractZone = z.infer<typeof ContractZoneSchema>;
export type Invariants   = z.infer<typeof InvariantsSchema>;
```

Eliminates interface↔schema drift; the inferred `why?: string | undefined` is fine for
consumers (they read the field, they don't assign explicit `undefined`).

## The meta-trap that let it through

**Vitest (esbuild) does NOT typecheck** — it transpiles per file. A subagent can report a
module "green" on `npx vitest run <file>` while `tsc` would reject it. When leaf modules are
built by parallel subagents (each told to run only its own vitest file, to avoid cross-tree
interference), the orchestrator MUST run `npm run typecheck` after they land — that is the
first time the modules are checked together and against strict-TS rules.

## Related
- [[critic-schema-json-not-copied-to-dist]] — another zod/schema wiring pitfall.
- `src/gate/invariants.ts` — the derive-from-schema fix in place.
