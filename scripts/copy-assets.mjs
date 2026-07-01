// Copies non-TS assets that `tsc` does not emit into `dist/`. Cross-platform
// (pure node:fs, no shell `cp`) so it runs identically on the Windows + Linux
// CI matrix. Runs as `postbuild`.
//
// Currently the only asset is the critic verdict JSON schema: the compiled
// critic resolves its `--output-schema` path relative to its own module
// (`DEFAULT_SCHEMA_PATH` in src/critic/codex-adapter.ts), i.e. from
// `dist/critic/`. `tsc` never copies the `.json`, so a compiled build's schema
// path would break without this step (gotcha `[critic/codex]`).
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** [from, to] pairs, repo-root-relative. */
const ASSETS = [["src/critic/critic-verdict.schema.json", "dist/critic/critic-verdict.schema.json"]];

for (const [from, to] of ASSETS) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log(`copy-assets: ${from} -> ${to}`);
}
