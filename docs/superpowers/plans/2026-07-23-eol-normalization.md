# EOL Normalization Before the Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize a worker's changed files toward LF (per the target repo's `.gitattributes`, default LF) after the dirty-file fence and before the diff/gate, so a new PHP file written with CRLF on Windows no longer trips the WPCS line-ending sniff.

**Architecture:** One new best-effort module `src/normalize/eol.ts` decides, per changed file, whether to rewrite `\r\n`→`\n` using git's own attribute resolution (`git check-attr text eol`). It is wired into `conductor.ts` as an optional dep called on the happy path, and built in `composition/root.ts` from `runNative` + `node:fs`. The module never throws to the conductor: a failure leaves files as-is (the pre-existing, safe behavior).

**Tech Stack:** TypeScript, ESM, Node ≥ 20, vitest. Shell-out via the existing `runNative` helper (`src/util/native.ts`). Dependency-injection for testability (mirrors `ConductorDeps` optional deps like `mainTreeStatus`).

**Spec:** `docs/superpowers/specs/2026-07-23-eol-normalization-design.md`

---

## File Structure

- **Create** `src/normalize/eol.ts` — the normalization unit. Exports:
  - `GitAttr` (type) — `{ text: "set" | "unset" | "unspecified"; eol: "lf" | "crlf" | "unspecified" }`.
  - `NormalizeResult` (type) — `{ normalized: string[]; skippedBinary: string[] }`.
  - `NormalizeEolDeps` (interface) — injected `checkAttr` / `readFile` / `writeFile` / `log`.
  - `parseCheckAttr(stdout: string): Map<string, GitAttr>` — pure parser of `git check-attr -z` output.
  - `normalizeWorktreeEol(deps, worktreePath, relPaths): Promise<NormalizeResult>` — the orchestration.
  - `gitCheckAttr(worktreePath, relPaths): Promise<Map<string, GitAttr>>` — the real git call (uses `runNative` + `parseCheckAttr`).
- **Create** `src/normalize/eol.test.ts` — unit tests for `parseCheckAttr` and `normalizeWorktreeEol`.
- **Modify** `src/conductor/conductor.ts` — add optional `normalizeEol` dep (interface ~line 44, near `mainTreeStatus`) + one call between the dirty-file fence and `// DIFF + CRITIC` (~line 641).
- **Modify** `src/composition/root.ts` — build `normalizeEol` and add it to the `ConductorDeps` object (~line 876).
- **Modify** `src/conductor/conductor.test.ts` — one test asserting the normalize dep is invoked with `touched` on the happy path (and not invoked when a fence escalates first).

---

## Task 1: The normalization module (`src/normalize/eol.ts`)

**Files:**
- Create: `src/normalize/eol.ts`
- Test: `src/normalize/eol.test.ts`

- [ ] **Step 1: Write the failing test for `parseCheckAttr`**

`git check-attr -z text eol -- <files>` emits NUL-terminated triples: `path\0attr\0value\0` repeated, two triples per file (one for `text`, one for `eol`). Create `src/normalize/eol.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { parseCheckAttr, normalizeWorktreeEol, type GitAttr, type NormalizeEolDeps } from "./eol.js";

const NUL = "\0";
function zRecords(...triples: Array<[string, string, string]>): string {
  return triples.map(([p, a, v]) => `${p}${NUL}${a}${NUL}${v}${NUL}`).join("");
}

describe("parseCheckAttr", () => {
  it("groups text+eol per path from -z output", () => {
    const stdout = zRecords(
      ["a.php", "text", "set"],
      ["a.php", "eol", "lf"],
      ["b.png", "text", "unset"],
      ["b.png", "eol", "unspecified"],
    );
    const m = parseCheckAttr(stdout);
    expect(m.get("a.php")).toEqual({ text: "set", eol: "lf" });
    expect(m.get("b.png")).toEqual({ text: "unset", eol: "unspecified" });
  });

  it("maps git's 'unspecified' sentinel and leaves a missing attr unspecified", () => {
    // A path git emits with no eol record at all still resolves to unspecified.
    const stdout = zRecords(["c.php", "text", "unspecified"]);
    const m = parseCheckAttr(stdout);
    expect(m.get("c.php")).toEqual({ text: "unspecified", eol: "unspecified" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/normalize/eol.test.ts`
Expected: FAIL — `Cannot find module './eol.js'` / `parseCheckAttr is not a function`.

- [ ] **Step 3: Implement `parseCheckAttr` + types in `src/normalize/eol.ts`**

```ts
/**
 * Normalize a worker's changed files toward LF before the gate reads them.
 *
 * A worker running on Windows writes a new file with CRLF (an OS/editor artifact,
 * not a choice). The `wordpress-woocommerce` profile's WPCS ruleset includes the
 * `Generic.Files.LineEndings` sniff, which (correctly, on that platform) reds a
 * brand-new file at line 1 -- and for a NEW file, line 1 is a worker-added line, so
 * line-scoping (`src/gate/finding-filter.ts`) cannot filter it as pre-existing. The
 * worker cannot fix it (rewriting on Windows re-introduces CRLF), so the task burns
 * its attempt budget and escalates. This module removes the artifact at its root:
 * it rewrites `\r\n` -> `\n` in the worker's changed files, so the diff, the critic,
 * the gate, and the commit all see LF -- exactly what git itself would produce on
 * commit under the repo's `.gitattributes`.
 *
 * The EOL policy is the TARGET REPO's own `.gitattributes`, resolved via
 * `git check-attr` (never re-implemented here), with LF the default when the repo is
 * silent. Fail toward NOT mangling (Principle 10): a declared-binary file, an
 * `eol=crlf` file, or an undeclared file whose bytes contain a NUL is left untouched.
 * The module is BEST-EFFORT: any failure leaves files as-is (the pre-existing, safe
 * behavior -- the sniff may red a new file, which parks the task, it does not merge
 * bad output), and it never throws to the conductor.
 *
 * Design: `docs/superpowers/specs/2026-07-23-eol-normalization-design.md`.
 */
import { runNative } from "../util/native.js";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";

/** git's own attribute vocabulary. `text: "unset"` is the `-text` "binary"
 *  declaration; `"unspecified"` means no attribute matched the path. */
export interface GitAttr {
  text: "set" | "unset" | "unspecified";
  eol: "lf" | "crlf" | "unspecified";
}

export interface NormalizeResult {
  /** Worktree-relative paths whose CRLF was rewritten to LF. */
  normalized: string[];
  /** Worktree-relative paths skipped because they looked binary (declared `-text`,
   *  or undeclared with a NUL byte). Reported so the conductor log is honest about
   *  what it did NOT touch. */
  skippedBinary: string[];
}

export interface NormalizeEolDeps {
  /** Resolve git attributes for `relPaths` in the worktree. Injected so the unit is
   *  testable without a real repo. */
  checkAttr: (worktreePath: string, relPaths: string[]) => Promise<Map<string, GitAttr>>;
  readFile: (absPath: string) => Promise<Buffer>;
  writeFile: (absPath: string, data: Buffer) => Promise<void>;
  log: (level: string, message: string) => void;
}

function attrValue(v: string): string {
  // git prints "set"/"unset"/"unspecified", or the literal value ("lf"/"crlf").
  return v;
}

/**
 * Parse `git check-attr -z text eol -- <files>` output: NUL-terminated triples
 * `path\0attr\0value\0`, repeated. Groups the per-path `text` and `eol` values into
 * one `GitAttr`. A path with a missing attr record defaults that field to
 * `"unspecified"` (git normally emits both, but this stays robust if it does not).
 */
export function parseCheckAttr(stdout: string): Map<string, GitAttr> {
  const out = new Map<string, GitAttr>();
  // Split on NUL; the trailing NUL yields one empty tail element to drop.
  const tokens = stdout.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i + 2 < tokens.length + 1 && i + 2 <= tokens.length - 1; ) {
    // Consume exactly three tokens: path, attr, value.
    const path = tokens[i]!;
    const attr = tokens[i + 1]!;
    const value = tokens[i + 2]!;
    i += 3;
    let rec = out.get(path);
    if (!rec) {
      rec = { text: "unspecified", eol: "unspecified" };
      out.set(path, rec);
    }
    if (attr === "text") {
      rec.text = value === "set" ? "set" : value === "unset" ? "unset" : "unspecified";
    } else if (attr === "eol") {
      rec.eol = value === "lf" ? "lf" : value === "crlf" ? "crlf" : "unspecified";
    }
    void attrValue;
  }
  return out;
}
```

> NOTE for the implementer: the `for` loop bound above is deliberately awkward to avoid an off-by-one on a well-formed (NUL-terminated) stream. Prefer this simpler, equivalent form and use it instead:
> ```ts
> for (let i = 0; i + 3 <= tokens.length; i += 3) {
>   const path = tokens[i]!, attr = tokens[i + 1]!, value = tokens[i + 2]!;
>   // ...same body...
> }
> ```
> Delete the `attrValue`/`void attrValue` helper — it is scaffolding, not needed.

- [ ] **Step 4: Run the `parseCheckAttr` tests to verify they pass**

Run: `npx vitest run src/normalize/eol.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing tests for `normalizeWorktreeEol`**

Append to `src/normalize/eol.test.ts`:

```ts
describe("normalizeWorktreeEol", () => {
  function makeDeps(
    attrs: Record<string, GitAttr>,
    files: Record<string, string>,
  ): { deps: NormalizeEolDeps; writes: Record<string, string>; logs: string[] } {
    const writes: Record<string, string> = {};
    const logs: string[] = [];
    const deps: NormalizeEolDeps = {
      checkAttr: async (_wt, relPaths) => {
        const m = new Map<string, GitAttr>();
        for (const p of relPaths) m.set(p, attrs[p] ?? { text: "unspecified", eol: "unspecified" });
        return m;
      },
      readFile: async (abs) => {
        const rel = abs.split(/[\\/]/).pop()!;
        return Buffer.from(files[rel] ?? "", "latin1");
      },
      writeFile: async (abs, data) => {
        const rel = abs.split(/[\\/]/).pop()!;
        writes[rel] = data.toString("latin1");
      },
      log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
    };
    return { deps, writes, logs };
  }

  it("rewrites CRLF to LF for an undeclared text file (default LF)", async () => {
    const { deps, writes } = makeDeps(
      { "a.php": { text: "unspecified", eol: "unspecified" } },
      { "a.php": "<?php\r\n$x = 1;\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["a.php"]);
    expect(r.normalized).toEqual(["a.php"]);
    expect(writes["a.php"]).toBe("<?php\n$x = 1;\n");
  });

  it("leaves an eol=crlf declared file untouched", async () => {
    const { deps, writes } = makeDeps(
      { "win.txt": { text: "set", eol: "crlf" } },
      { "win.txt": "a\r\nb\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["win.txt"]);
    expect(r.normalized).toEqual([]);
    expect(writes["win.txt"]).toBeUndefined();
  });

  it("leaves a declared-binary (-text) file untouched", async () => {
    const { deps, writes } = makeDeps(
      { "logo.bin": { text: "unset", eol: "unspecified" } },
      { "logo.bin": "\x00\x01\r\n\x02" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["logo.bin"]);
    expect(r.normalized).toEqual([]);
    expect(writes["logo.bin"]).toBeUndefined();
  });

  it("skips an undeclared file whose bytes contain a NUL (binary heuristic)", async () => {
    const { deps, writes } = makeDeps(
      { "blob.dat": { text: "unspecified", eol: "unspecified" } },
      { "blob.dat": "PK\x03\x04\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["blob.dat"]);
    expect(r.normalized).toEqual([]);
    expect(r.skippedBinary).toEqual(["blob.dat"]);
    expect(writes["blob.dat"]).toBeUndefined();
  });

  it("normalizes an explicitly eol=lf file even if it contains a NUL (declaration overrides the guard)", async () => {
    const { deps, writes } = makeDeps(
      { "weird.php": { text: "set", eol: "lf" } },
      { "weird.php": "a\r\n\x00b\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["weird.php"]);
    expect(r.normalized).toEqual(["weird.php"]);
    expect(writes["weird.php"]).toBe("a\n\x00b\n");
  });

  it("does not rewrite an already-LF file (no needless write)", async () => {
    const { deps, writes } = makeDeps(
      { "clean.php": { text: "unspecified", eol: "unspecified" } },
      { "clean.php": "<?php\n$x = 1;\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["clean.php"]);
    expect(r.normalized).toEqual([]);
    expect(writes["clean.php"]).toBeUndefined();
  });

  it("processes a mixed batch: normalizes the text file, skips the binary, leaves crlf-declared", async () => {
    const { deps, writes } = makeDeps(
      {
        "a.php": { text: "unspecified", eol: "unspecified" },
        "b.bin": { text: "unset", eol: "unspecified" },
        "c.txt": { text: "set", eol: "crlf" },
      },
      { "a.php": "x\r\n", "b.bin": "\x00\r\n", "c.txt": "y\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["a.php", "b.bin", "c.txt"]);
    expect(r.normalized).toEqual(["a.php"]);
    expect(writes["a.php"]).toBe("x\n");
    expect(writes["b.bin"]).toBeUndefined();
    expect(writes["c.txt"]).toBeUndefined();
  });

  it("fails safe: a checkAttr rejection normalizes nothing and logs a WARN", async () => {
    const logs: string[] = [];
    const deps: NormalizeEolDeps = {
      checkAttr: async () => {
        throw new Error("git boom");
      },
      readFile: async () => Buffer.from(""),
      writeFile: async () => {
        throw new Error("should not write");
      },
      log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
    };
    const r = await normalizeWorktreeEol(deps, "/wt", ["a.php"]);
    expect(r.normalized).toEqual([]);
    expect(logs.some((l) => l.startsWith("WARN"))).toBe(true);
  });

  it("continues past a per-file read failure (partial normalization is safe)", async () => {
    const writes: Record<string, string> = {};
    const logs: string[] = [];
    const deps: NormalizeEolDeps = {
      checkAttr: async (_wt, relPaths) => {
        const m = new Map<string, GitAttr>();
        for (const p of relPaths) m.set(p, { text: "unspecified", eol: "unspecified" });
        return m;
      },
      readFile: async (abs) => {
        if (abs.endsWith("bad.php")) throw new Error("EIO");
        return Buffer.from("z\r\n", "latin1");
      },
      writeFile: async (abs, data) => {
        writes[abs.split(/[\\/]/).pop()!] = data.toString("latin1");
      },
      log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
    };
    const r = await normalizeWorktreeEol(deps, "/wt", ["bad.php", "ok.php"]);
    expect(r.normalized).toEqual(["ok.php"]);
    expect(writes["ok.php"]).toBe("z\n");
    expect(logs.some((l) => l.startsWith("WARN"))).toBe(true);
  });
});
```

- [ ] **Step 6: Run the new tests to verify they fail**

Run: `npx vitest run src/normalize/eol.test.ts`
Expected: FAIL — `normalizeWorktreeEol is not a function`.

- [ ] **Step 7: Implement `normalizeWorktreeEol` + `gitCheckAttr` in `src/normalize/eol.ts`**

Append to `src/normalize/eol.ts`:

```ts
/** Decide the LF-normalization action for one file given its git attributes and a
 *  binary-heuristic hint. Pure, so the policy table is trivially reviewable.
 *  - declared binary (`text: "unset"`) -> skip.
 *  - `eol: "crlf"` -> skip (repo explicitly wants CRLF).
 *  - `eol: "lf"` OR `text: "set"` -> normalize (an explicit text/eol declaration is
 *    the operator's word; it overrides the NUL guard).
 *  - otherwise (unspecified) -> normalize UNLESS the bytes look binary (NUL present). */
function decide(attr: GitAttr, looksBinary: boolean): "normalize" | "skip" | "skip-binary" {
  if (attr.text === "unset") return "skip-binary";
  if (attr.eol === "crlf") return "skip";
  if (attr.eol === "lf" || attr.text === "set") return "normalize";
  // Unspecified: default LF, guarded by the binary heuristic.
  return looksBinary ? "skip-binary" : "normalize";
}

const CR = 0x0d;
const LF = 0x0a;
const NUL_BYTE = 0x00;

/** Rewrite every CRLF to LF in a buffer. Returns the same buffer instance when there
 *  was no CRLF at all, so the caller can cheaply detect "nothing to write". A lone
 *  `\r` (old-Mac) is deliberately left alone -- the observed artifact is specifically
 *  CRLF, and touching bare `\r` would widen the blast radius past the problem. */
function crlfToLf(buf: Buffer): { out: Buffer; changed: boolean } {
  // Fast path: no CR byte -> nothing to do.
  if (!buf.includes(CR)) return { out: buf, changed: false };
  const result: number[] = [];
  let changed = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === CR && i + 1 < buf.length && buf[i + 1] === LF) {
      // skip the CR; the LF is emitted on the next iteration
      changed = true;
      continue;
    }
    result.push(buf[i]!);
  }
  return { out: Buffer.from(result), changed };
}

/**
 * Normalize the worker's changed files toward LF. Best-effort and non-throwing: a
 * `checkAttr` failure normalizes nothing (WARN + empty result); a per-file read/write
 * failure skips that one file (WARN) and continues. See the module doc comment.
 */
export async function normalizeWorktreeEol(
  deps: NormalizeEolDeps,
  worktreePath: string,
  relPaths: string[],
): Promise<NormalizeResult> {
  const result: NormalizeResult = { normalized: [], skippedBinary: [] };
  if (relPaths.length === 0) return result;

  let attrs: Map<string, GitAttr>;
  try {
    attrs = await deps.checkAttr(worktreePath, relPaths);
  } catch (err) {
    deps.log("WARN", `normalizeWorktreeEol: git check-attr failed, normalizing nothing this task: ${String(err)}`);
    return result;
  }

  for (const rel of relPaths) {
    const attr = attrs.get(rel) ?? { text: "unspecified", eol: "unspecified" };
    const abs = join(worktreePath, rel);
    try {
      const buf = await deps.readFile(abs);
      const looksBinary = buf.includes(NUL_BYTE);
      const action = decide(attr, looksBinary);
      if (action === "skip-binary") {
        result.skippedBinary.push(rel);
        continue;
      }
      if (action === "skip") continue;
      const { out, changed } = crlfToLf(buf);
      if (!changed) continue; // already LF -> no needless write
      await deps.writeFile(abs, out);
      result.normalized.push(rel);
    } catch (err) {
      deps.log("WARN", `normalizeWorktreeEol: skipping ${rel} (read/write failed): ${String(err)}`);
    }
  }

  return result;
}

/**
 * Real `git check-attr` for a worktree: one batched call over all `relPaths` using
 * `-z` (NUL-delimited, so paths with spaces/UTF-8 are safe). Run with cwd = the
 * worktree so the worktree's own `.gitattributes` applies. Attributes resolve by path
 * PATTERN, not tracking status, so a brand-new (untracked) file is handled correctly.
 */
export async function gitCheckAttr(worktreePath: string, relPaths: string[]): Promise<Map<string, GitAttr>> {
  if (relPaths.length === 0) return new Map();
  const r = await runNative("git", ["check-attr", "-z", "text", "eol", "--", ...relPaths], { cwd: worktreePath });
  if (r.exitCode !== 0) {
    throw new Error(`git check-attr failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  }
  return parseCheckAttr(r.stdout);
}

/** Default deps binding the real git call + node fs. `log` is injected by the caller
 *  (the composition root) so this module has no logging dependency of its own. */
export function makeNormalizeEolDeps(log: (level: string, message: string) => void): NormalizeEolDeps {
  return {
    checkAttr: gitCheckAttr,
    readFile: (abs) => fsReadFile(abs),
    writeFile: (abs, data) => fsWriteFile(abs, data),
    log,
  };
}
```

- [ ] **Step 8: Run all module tests to verify they pass**

Run: `npx vitest run src/normalize/eol.test.ts`
Expected: PASS (all `parseCheckAttr` + `normalizeWorktreeEol` tests).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 10: Commit**

```bash
git add src/normalize/eol.ts src/normalize/eol.test.ts
git commit -m "feat(normalize): CRLF->LF EOL normalization module (per .gitattributes, default LF)"
```

---

## Task 2: Wire into the conductor + composition root

**Files:**
- Modify: `src/conductor/conductor.ts` (dep interface ~line 44; call site ~line 641)
- Modify: `src/composition/root.ts` (~line 876, the `ConductorDeps` object)
- Test: `src/conductor/conductor.test.ts`

- [ ] **Step 1: Add the optional dep to `ConductorDeps`**

In `src/conductor/conductor.ts`, in the `ConductorDeps` interface, right after the `mainTreeStatus?` dep (~line 44), add:

```ts
  /** Best-effort EOL normalization of the worker's changed files toward LF
   *  (`src/normalize/eol.ts`), called on the happy path AFTER the fences and BEFORE
   *  the diff, so the critic, the gate, and the commit all see LF. Optional so the
   *  fake-driven conductor tests are untouched; when omitted the step is skipped.
   *  Never throws (the module is best-effort). */
  normalizeEol?: (wt: Worktree, relPaths: string[]) => Promise<import("../normalize/eol.js").NormalizeResult>;
```

> If the file already imports from `../normalize/eol.js` elsewhere, prefer a top-level `import type { NormalizeResult } from "../normalize/eol.js";` and use `Promise<NormalizeResult>` here instead of the inline import. Match the file's existing import style.

- [ ] **Step 2: Add the call site between the dirty-file fence and the diff**

In `src/conductor/conductor.ts`, find the end of the DIRTY-FILE FENCE block (the `}` closing `if (stray.length > 0 || forbidden.length > 0) { ... return ...; }`, ~line 640) and the `// DIFF + CRITIC` comment (~line 642). Insert between them:

```ts
          // EOL NORMALIZATION -- the worker's Windows editor may have written CRLF, an
          // environmental artifact the WPCS line-ending sniff would (correctly, on that
          // platform) red on a brand-new file. Normalize the worker's changed files
          // toward LF per the target repo's .gitattributes (default LF) BEFORE the diff,
          // so the critic, the gate, and the commit all see the same LF content. Scoped
          // to `touched` -- the files that actually changed; strays already escalated
          // above. Best-effort: the module never throws, so no try/catch is needed here.
          if (deps.normalizeEol && touched.length > 0) {
            const eolResult = await deps.normalizeEol(wt, touched);
            if (eolResult.normalized.length > 0) {
              safeLog(
                "INFO",
                `conductor: normalized CRLF->LF in ${eolResult.normalized.length} file(s): ${eolResult.normalized.join(", ")}`,
              );
            }
          }
```

> VERIFY while implementing: (a) `touched` is in scope here (it is computed at the "POST-WORKER TOUCHED SET" block, ~line 587) and holds worktree-relative paths; (b) the log helper is `safeLog` (grep the file — the conductor wraps `deps.log` in a `safeLog` for fail-closed logging; use whatever the surrounding code uses); (c) `deps` is the in-scope ConductorDeps reference (grep the surrounding code — it may be destructured; if the file destructures deps, add `normalizeEol` to the destructure and call it bare).

- [ ] **Step 3: Write the failing conductor test**

In `src/conductor/conductor.test.ts`, add a test that a happy-path task (one that commits) invokes `normalizeEol` with the touched set. Find an existing green-path test to copy the harness/fixture setup from (grep for a test that reaches `runGate` and commits). Add:

```ts
it("normalizes the worker's changed files (EOL) after the fences, before the gate", async () => {
  const calls: Array<{ paths: string[] }> = [];
  const deps = makeDeps({
    // ...reuse the existing happy-path deps builder in this file...
  });
  deps.normalizeEol = async (_wt, relPaths) => {
    calls.push({ paths: relPaths });
    return { normalized: [], skippedBinary: [] };
  };
  const conductor = createConductor(deps);
  await conductor.runIteration();
  expect(calls.length).toBe(1);
  expect(calls[0]!.paths.length).toBeGreaterThan(0);
});
```

> The exact `makeDeps`/fixture shape MUST match this test file's existing helpers — do not invent a new harness. Read the file first, find the closest existing "worker writes → fences pass → gate → commit" test, and clone its setup, adding only the `deps.normalizeEol` stub and the two assertions. If the file's happy-path test asserts a commit, assert here that `normalizeEol` was called BEFORE the commit-observable outcome (e.g. by capturing call order), keeping the ordering claim honest.

- [ ] **Step 4: Run the conductor test to verify it fails**

Run: `npx vitest run src/conductor/conductor.test.ts -t "normalizes the worker"`
Expected: FAIL — `calls.length` is 0 (dep not yet wired into the flow) OR the assertion on ordering fails.

- [ ] **Step 5: Confirm the call site makes the test pass**

The call site added in Step 2 is what satisfies this test. Run:

Run: `npx vitest run src/conductor/conductor.test.ts -t "normalizes the worker"`
Expected: PASS.

- [ ] **Step 6: Wire the real dep in the composition root**

In `src/composition/root.ts`, add the import (near the other conductor-dep imports at the top):

```ts
import { normalizeWorktreeEol, makeNormalizeEolDeps } from "../normalize/eol.js";
```

Then, just above the `const deps: ConductorDeps = {` object (~line 860), build the binding:

```ts
  // EOL normalization dep: bind the real git check-attr + node fs, with the same
  // `log` the rest of the conductor uses. Best-effort; see src/normalize/eol.ts.
  const eolDeps = makeNormalizeEolDeps(log);
  const normalizeEol = (wt: Worktree, relPaths: string[]) => normalizeWorktreeEol(eolDeps, wt.path, relPaths);
```

And add `normalizeEol,` to the `ConductorDeps` object literal (near `harvestWorkerReport,`):

```ts
    harvestWorkerReport,
    normalizeEol,
    gitChangedPaths,
```

> VERIFY: `Worktree` is already imported in root.ts (it is used by `worktreeGit`); if not, add `import type { Worktree } from "../worktree/worktree.js";`.

- [ ] **Step 7: Full typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 8: Run the conductor + normalize test suites**

Run: `npx vitest run src/conductor/conductor.test.ts src/normalize/eol.test.ts src/composition/root.test.ts`
Expected: PASS (no regressions in the conductor/root suites).

- [ ] **Step 9: Commit**

```bash
git add src/conductor/conductor.ts src/composition/root.ts src/conductor/conductor.test.ts
git commit -m "feat(conductor): normalize worker EOL to LF after the fences, before the gate"
```

---

## Task 3: Full suite + independent critic review (not a subagent — the main session drives this)

- [ ] **Step 1: Run the whole test suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: all green (~1611 tests + the new ones), typecheck clean.

- [ ] **Step 2: Independent codex critic gate (pinned model)**

Per `AGENTS.md` review discipline, this diff gets an independent **codex `gpt-5.6-luna`** review before merge. Run codex DIRECTLY (not via the subagent), pasting the whole diff inline (codex cannot read files on Windows):

```bash
git diff main...feat/eol-normalization > /tmp/eol-diff.patch   # or capture with git --no-pager diff
# compose a review prompt embedding the diff whole, then:
cat prompt.txt | codex exec --model gpt-5.6-luna --skip-git-repo-check -
```

Address findings; re-critic in-place fixes (never self-certify). Declines are allowed with rationale verified against the real code.

---

## Task 4: Live proof on the polygon (main session)

The whole point of the change — operator-observable, per "prove the product goal".

- [ ] **Step 1: Prepare the polygon**

`woodev-shipping-plugin-test` on `autodev/main`, tree clean, profile `wordpress-woocommerce@2`. Per the s52 recipe, turn `gate.agentCi.enabled` OFF for a native-Windows live proof (restore after). Confirm `vendor` is provisioned.

- [ ] **Step 2: Enqueue a task that ADDS a new `.php` file**

Compose a minimal harness run whose task creates a brand-new compliant `.php` file (a small WPCS-clean class/function in a new file under `includes/`). Before this change, such a task escalated on the line-1 CRLF finding.

- [ ] **Step 3: Run headless in the FOREGROUND**

Run: `node dist/index.js run --once` from the polygon dir.
Expected: the conductor log shows `normalized CRLF->LF in 1 file(s): <path>`; the phpcs gate is green on the added lines (`profile_green: true`); the task reaches DONE with a commit.

- [ ] **Step 4: Confirm the committed file is LF**

Run: `git show HEAD:<new-file-path> | file -` (or inspect bytes) on the polygon — the committed new file has LF endings, and the phpcs gate did not red it.

- [ ] **Step 5: Restore the polygon**

Restore `gate.agentCi.enabled` to its found value; leave the tree clean.

---

## Self-Review (checked against the spec)

- **Spec coverage:** normalize toward LF (Task 1 `crlfToLf` + `decide`) ✓; `.gitattributes` via `git check-attr` (`gitCheckAttr`) ✓; default LF (`decide` unspecified branch) ✓; binary/`-text`/`eol=crlf` skip (`decide`) ✓; NUL guard for unspecified (`looksBinary`) ✓; scoped to `touched` (Task 2 call site) ✓; after fences / before diff (Task 2 placement) ✓; best-effort / never throws (Task 1 try/catch + Task 2 no-throw contract) ✓; log line (Task 2) ✓; unit tests 1-8 from the spec (Task 1 Step 5) ✓; conductor ordering test (Task 2 Step 3) ✓; live proof (Task 4) ✓.
- **Placeholder scan:** the only "fill-in" is the conductor test's `makeDeps` shape, which is explicitly delegated to the file's existing helper (a real, unavoidable "match the local harness" instruction, not a vague placeholder). All module code is complete.
- **Type consistency:** `NormalizeResult` / `GitAttr` / `NormalizeEolDeps` names are used identically across Task 1 and Task 2. `normalizeEol` dep signature `(wt, relPaths) => Promise<NormalizeResult>` matches the composition-root binding.
- **Non-goals honored:** no ruleset edit, no whole-tree scan, no new config field, no CRLF-target path.

## Related

- Spec: `docs/superpowers/specs/2026-07-23-eol-normalization-design.md`
- `docs/PRINCIPLES.md` #10 (fail safe), #13 (evidence), #15 (formalized properties)
- `docs/gotchas/profile-gates-must-be-diff-scoped.md`
