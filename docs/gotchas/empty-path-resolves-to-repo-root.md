# `[path/empty-resolves-to-root]` — an empty path string `resolve()`s to the repo root, not "absent"

**Tag:** `[path/empty-resolves-to-root]`
**Found:** s54 (codex gpt-5.6-luna gate, round 1, on the north-star reader)

## The trap

`path.resolve(repoRoot, p)` with `p === ""` returns **`repoRoot` itself** — the empty
second segment is discarded, leaving the accumulated absolute path. So a reader that does

```ts
const abs = resolve(repoRoot, p);
return existsSync(abs) ? await readFile(abs, "utf8") : null;
```

with `p === ""` reads **`repoRoot`, a directory** → `existsSync(repoRoot)` is `true` →
`readFile(<a directory>)` throws **`EISDIR`**. If the caller (here `getIntent`) does not
catch, the throw propagates and can crash the run.

## Why it was latent, then reopened

The s54 north-star reader replaced an older `existsSync(p) ? readFile(p) : null` with a
`resolve(repoRoot, p)`-then-read (to resolve relative intent paths against the trusted
repoRoot instead of the process cwd — `serve` is daemon-global). The OLD form was
*accidentally* safe for the empty case: `existsSync("")` is `false`, so `p === ""`
returned `null`. Introducing `resolve` turned that harmless-null into an EISDIR crash,
because `resolve(root, "")` is a real, existing directory. An operator's explicit
`intentSource: ""` (a nullable-but-set config) reached it in attended anti-drift.

## The rule

1. **Short-circuit an empty/whitespace path BEFORE `resolve`** — treat it as "not
   configured", return `null`. `resolve(root, "")` is the repo root, never "absent".
2. **A shared file reader must honor its "null if not readable" contract and NEVER
   throw** (Principle 10): wrap the `existsSync`/`readFile` in a `try/catch` that maps
   ANY error — a directory target (EISDIR), EACCES, an existsSync→readFile race — to
   `null`. A "return null if absent" contract that actually throws on a directory is a
   fail-toward-crash.
3. Give ONE reader to every consumer (the anti-drift model check AND the north-star
   preflight both use `makeIntentReader`) so a path can never be resolved two different
   ways — the recurring `[critic/validated-one-string-used-another]` shape.

The fix (`makeIntentReader` in `composition/root.ts`) is exported and unit-pinned:
empty/whitespace → null (read never attempted); a throwing readFile → null; absent →
null; a real relative path → content resolved against repoRoot.

## Related

- [[validated-one-string-used-another]] — the shared-reader rule (one resolution, one function).
- [[never-throws-catch-block-logging]] — the same fail-closed discipline for best-effort paths.
- `docs/superpowers/specs/2026-07-23-mandatory-anti-drift-north-star-design.md` — the feature this reader serves.
