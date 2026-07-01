# `[ts/typecheck-scope]` — an emit-scoped tsconfig silently skips `test/**` in `tsc`

**Tag:** `[ts/typecheck-scope]`
**Found:** s08 (2026-07-01), building the Task 28 parity harness under `test/parity/`.

## Symptom

`npm run typecheck` (`tsc -p tsconfig.json --noEmit`) was **green even for a brand-new
file under `test/`** — it never actually looked at `test/parity/parity.test.ts`. A type
error there would ship undetected. `--listFilesOnly` confirmed zero `test/` matches in
the program.

## Cause

`tsconfig.json` is the **emit/build** config: `"rootDir": "src"` +
`"include": ["src/**/*.ts"]`. Colocated `src/**/*.test.ts` ARE covered (they match
`src/**/*.ts`), which is why per-module tests typecheck fine — but anything under the
top-level `test/` tree is outside `include` and is never added to the program. `vitest`
transpiles-and-runs those files (its own `include` covers `test/**`), so tests pass, but
`vitest` does NOT typecheck — the two are independent. Net: `test/**` is **vacuously
green** under `npm run typecheck`.

## Fix

Add a dedicated **typecheck** config that widens the program without breaking the
emit config:

```jsonc
// tsconfig.typecheck.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "rootDir": "." }, // rootDir "." avoids TS6059
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["dist", "node_modules", "test/fixtures"]
}
```

Point the script at it: `"typecheck": "tsc -p tsconfig.typecheck.json"`. Keep `build`
on the original `tsconfig.json` (so `dist/` still mirrors `src/` only — you do NOT want
`test/` emitted). `rootDir: "."` is required: with the inherited `rootDir: "src"`, files
under `test/` trip **TS6059 "not under rootDir"**.

## Lesson

A green typecheck is only as trustworthy as the config's `include`. Any time you add a
source tree OUTSIDE the build root (a `test/`, `scripts/`, `tools/` dir), verify `tsc`
actually sees it (`--listFilesOnly | grep`), or it is silently unchecked.

## Related
- `[ts/zod]` — vitest doesn't typecheck; run `npm run typecheck` after subagents.
- `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md` — Tasks 28–29.
