# Gotcha — `critic-verdict.schema.json` is not copied to `dist/` by `tsc`

**Tag:** `[critic/codex]` · **Discovered:** s04 (2026-07-01), codex gate on the critic module.

## The trap

`src/critic/codex-adapter.ts` resolves the codex `--output-schema` file relative to
the module:

```ts
export const DEFAULT_SCHEMA_PATH =
  fileURLToPath(new URL("./critic-verdict.schema.json", import.meta.url));
```

`tsc` (our `build` script) compiles `.ts` → `dist/` but **does not copy `.json`
assets**. So after a real `npm run build`, `dist/critic/critic-verdict.schema.json`
does **not** exist, and a live `codex exec --output-schema <path>` from the compiled
daemon points at a missing file.

## Why it's not biting yet

Tests and the `ADH_LIVE=1` live path run from **source** via vitest/esbuild, where the
`.json` sits next to the `.ts`. So dev + CI (typecheck + vitest) are green and the
hazard is invisible — it only appears when someone runs the compiled `dist/`.

## Guard in place

`DEFAULT_SCHEMA_PATH` is exported and a unit test asserts the **source** file exists
(`codex-adapter.test.ts`) — this catches a future rename/move of the schema, but NOT
the dist-copy gap.

## The fix (DEFERRED to the packaging/CI task — plan Task 29)

Pick one when packaging is wired:
1. Copy `src/critic/*.json` into `dist/` as a `build` post-step (cross-platform Node
   copy, not `cp`), **or**
2. Embed the schema as a TS constant and write it to a temp file at call time (removes
   the external-asset dependency entirely — most robust).

Until then: the critic works from source; do not assume `dist/` is runnable.

## Related
- `docs/gotchas/codex-exec-windows-sandbox-review-inline-diff.md` — the sibling
  codex-on-Windows gotcha.
- Plan Task 29 (`docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md`) — CI +
  cross-platform packaging, where this dist-copy belongs.
