# M3 — New Project Flow (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the daemon the M3 backend of the multi-project shell: a server-side
folder browser (`GET /fs/dirs`), project registration/unregistration
(`POST /projects`, `DELETE /projects/:id`), and `.autodev/` scaffolding — per spec
`docs/superpowers/specs/2026-07-03-p3-multiproject-shell-design.md` §3c/§3e/§5/§6/§7.

**Architecture:** Three new pure-ish modules under `src/` (fs browser, scaffold,
project admin), each TDD'd against a real tmp-dir filesystem like the existing
registry tests; the API server gains one optional `admin` port (mirrors the
`onOrchestrate` pattern: absent → those routes 404); `src/index.ts` wires the real
implementations in `serve` mode only (untested glue, same status as the rest of the
composition root). Registry mutations are serialized through a promise-chain mutex
(two concurrent POSTs must not lose a write). Scaffold is transactional-ish:
`config.yaml` is validated BEFORE any fs write and written LAST with `wx`; stubs are
`wx`-with-EEXIST-skip so an existing blackboard file is never clobbered.

**Tech Stack:** Node LTS + TypeScript (ESM `.js` imports, strict NodeNext,
`exactOptionalPropertyTypes`), zod, `yaml` (already a dependency — `parse` AND
`stringify`), vitest with real `mkdtemp` filesystems, the existing `http`+`ws`
server in `src/api/server.ts`.

**Branch:** `autodev/s17-m3-new-project` (created from `main` in Task 1).

---

## Grounding decisions (locked here, verified in-code 2026-07-03)

1. **Scaffold layout mirrors aurora** (the only live-proven layout) — dirs:
   `.autodev/queue/{pending,active,done,escalated,quarantine}/`, `.autodev/runtime/`,
   `.autodev/escalations/`, `.autodev/runs/`, `.autodev/worktrees/`. These are exactly
   the paths `FileBlackboardRepository`, `escalate`, `createRecordRunCapability`, and
   `createWorktreeManager` use (all tolerate absence, but pre-creating them makes the
   project browsable in the UI immediately).
2. **Contract stubs live under `.autodev/`** (PS-oracle convention: the real
   woodev `.autodev/` holds `GOAL.md`/`INVARIANTS.md`/`GUARDS.md`; runbook §
   blackboard layout). The scaffolded `config.yaml` sets
   `contract.invariantsFile: .autodev/INVARIANTS.md` and
   `contract.guardsFile: .autodev/GUARDS.md` so the stubs are LIVE (read by
   `zonesTouchedInDiff` from the main root), not dead files. Known, already-documented
   limitation (`[conductor/wiring]`): the gate loads contract files from the worktree,
   where git-excluded `.autodev/` is absent → empty invariants there; main-root zone
   detection still works.
3. **`antiDrift.intentSource` stays null** (default): it is read relative to
   `process.cwd()`, which is meaningless for the daemon-global `serve` — pointing it
   at `.autodev/GOAL.md` would break. GOAL.md is still scaffolded as the operator's
   anchor doc.
4. **INVARIANTS.md stub must parse**: `parseInvariants` requires the
   `<!-- BEGIN/END MACHINE-INVARIANTS -->` markers with fenced JSON matching the
   strict `InvariantsSchema` (`{version, updated, contract_zones, constitution:{path_globs}}`).
5. **`scaffold` defaults to ON** in `POST /projects` (spec §5: checkbox default ON);
   safe because scaffold self-skips when `.autodev/config.yaml` already exists.
6. **Registered path is stored canonicalized** (`realpath`) so the registry never
   holds a symlink alias of an already-registered repo.
7. **DELETE also closes the project's watcher** (improves on the previously
   "accepted lingering watcher": we now observe the removal, so clean it —
   `[multiproject/id-keyed-caches]` fire-time guards stay as defense in depth).
8. **`.git` may be a FILE** (worktree/submodule): scaffold then skips the
   `.git/info/exclude` append with a WARN (never fails registration).

## File structure

| File | Responsibility |
|---|---|
| `src/registry/registry.ts` (modify) | export `isPathRegistered` (extracted from `addProject`'s dup check) |
| `src/registry/registry.test.ts` (modify) | tests for `isPathRegistered` |
| `src/fsbrowse/fsbrowse.ts` (create) | `listDirs` — dirs-only listing, git/registered badges, symlink annotation, roots view |
| `src/fsbrowse/fsbrowse.test.ts` (create) | tmp-dir tests incl. symlink/junction + traversal cases |
| `src/registry/scaffold.ts` (create) | `ScaffoldFormSchema`, `buildConfigYaml` (validated round-trip), `scaffoldProject` |
| `src/registry/scaffold.test.ts` (create) | scaffold tests: fresh repo, never-clobber, exclude append, round-trip via `loadConfig` |
| `src/registry/admin.ts` (create) | `createProjectAdmin` — register/unregister/isRegistered behind a mutex |
| `src/registry/admin.test.ts` (create) | admin tests incl. concurrent-register race |
| `src/api/server.ts` (modify) | routes `GET /fs/dirs`, `POST /projects`, `DELETE /projects/:id` via optional `deps.admin` |
| `src/api/server.test.ts` (modify) | route tests against a fake admin port |
| `src/index.ts` (modify) | wire `createProjectAdmin` + `listDirs` into `serve` (untested glue) |

---

### Task 1: Branch + `isPathRegistered` export in the registry

**Files:**
- Modify: `src/registry/registry.ts`
- Modify: `src/registry/registry.test.ts`

- [ ] **Step 1: Create the branch**

```bash
git checkout main && git pull && git checkout -b autodev/s17-m3-new-project
```

- [ ] **Step 2: Write the failing test**

Append to `src/registry/registry.test.ts` (follow the file's existing describe style):

```ts
describe("isPathRegistered", () => {
  it("is true for an exact registered path and false for an unregistered one", () => {
    const registry: Registry = { projects: [{ id: "a", name: "a", path: join(tmpBase, "a") }] };
    expect(isPathRegistered(registry, join(tmpBase, "a"))).toBe(true);
    expect(isPathRegistered(registry, join(tmpBase, "b"))).toBe(false);
  });

  it("normalizes redundant path segments before comparing", () => {
    const p = join(tmpBase, "a");
    const registry: Registry = { projects: [{ id: "a", name: "a", path: p }] };
    expect(isPathRegistered(registry, join(tmpBase, ".", "a"))).toBe(true);
  });

  it("case-folds on win32 only", () => {
    const p = join(tmpBase, "CaseDir");
    const registry: Registry = { projects: [{ id: "a", name: "a", path: p }] };
    const flipped = p.toLowerCase();
    expect(isPathRegistered(registry, flipped)).toBe(process.platform === "win32");
  });
});
```

Adjust imports at the top of the test file: add `isPathRegistered` and (if not
present) `join`; `tmpBase` = whatever tmp-root variable the file already uses (or
`tmpdir()` if it uses none for pure tests).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/registry/registry.test.ts`
Expected: FAIL — `isPathRegistered` is not exported.

- [ ] **Step 4: Implement**

In `src/registry/registry.ts`, add below the existing `pathKey` helper and refactor
`addProject` to use it:

```ts
/** True when `path` already resolves to a registered project's path (same
 *  canonical key as `addProject`'s duplicate check — win32 case-fold included). */
export function isPathRegistered(registry: Registry, path: string): boolean {
  const key = pathKey(path);
  return registry.projects.some((p) => pathKey(p.path) === key);
}
```

And in `addProject`, replace the inline `some(...)` duplicate check with:

```ts
  if (isPathRegistered(registry, input.path)) {
    throw new Error(`registry: path already registered: ${input.path}`);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/registry/registry.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/registry/registry.ts src/registry/registry.test.ts
git commit -m "feat(registry): export isPathRegistered (shared dup-path check)"
```

---

### Task 2: `src/fsbrowse/fsbrowse.ts` — the folder-browser module

**Files:**
- Create: `src/fsbrowse/fsbrowse.ts`
- Create: `src/fsbrowse/fsbrowse.test.ts`

Contract (spec §3e + §6): dirs-only listing of an absolute path; each entry
annotated `isGitRepo` / `isRegistered`; symlinks/junctions to dirs are included but
annotated (`isSymlink: true`) with `path` = the RESOLVED real target (never followed
silently); files never listed; unreadable entries skipped entry-level; invalid path
→ typed `invalid_path` error (route maps to 400, never 500); no `path` param → drive
roots on win32 / listing of `/` on POSIX.

- [ ] **Step 1: Write the failing tests**

Create `src/fsbrowse/fsbrowse.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirs, type FsBrowseDeps } from "./fsbrowse.js";

let base: string;

const deps = (registered: string[] = []): FsBrowseDeps => ({
  isRegistered: async (p) => registered.some((r) => r.toLowerCase() === p.toLowerCase()),
});

beforeEach(() => {
  // realpathSync: on macOS/Windows tmpdir itself may be a symlink/8.3 alias --
  // canonicalize the base so assertions compare canonical paths to canonical paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), "adh-fsb-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("listDirs", () => {
  it("lists only directories, sorted by name, never files", async () => {
    mkdirSync(join(base, "beta"));
    mkdirSync(join(base, "alpha"));
    writeFileSync(join(base, "file.txt"), "x");

    const res = await listDirs(base, deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(res.path).toBe(base);
  });

  it("annotates isGitRepo (a .git dir OR a .git file both count)", async () => {
    mkdirSync(join(base, "repo", ".git"), { recursive: true });
    mkdirSync(join(base, "wt"));
    writeFileSync(join(base, "wt", ".git"), "gitdir: elsewhere");
    mkdirSync(join(base, "plain"));

    const res = await listDirs(base, deps());
    if (!res.ok) throw new Error("expected ok");
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName["repo"]!.isGitRepo).toBe(true);
    expect(byName["wt"]!.isGitRepo).toBe(true);
    expect(byName["plain"]!.isGitRepo).toBe(false);
  });

  it("annotates isRegistered via the injected registry check", async () => {
    mkdirSync(join(base, "reg"));
    mkdirSync(join(base, "unreg"));

    const res = await listDirs(base, deps([join(base, "reg")]));
    if (!res.ok) throw new Error("expected ok");
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName["reg"]!.isRegistered).toBe(true);
    expect(byName["unreg"]!.isRegistered).toBe(false);
  });

  it("includes a dir-symlink annotated with its resolved real target, never silently followed", async () => {
    const target = join(base, "real-target");
    mkdirSync(target);
    // 'junction' works without admin rights on Windows; plain dir symlink on POSIX.
    symlinkSync(target, join(base, "link"), "junction");

    const res = await listDirs(base, deps());
    if (!res.ok) throw new Error("expected ok");
    const link = res.entries.find((e) => e.name === "link");
    expect(link).toBeDefined();
    expect(link!.isSymlink).toBe(true);
    // path is the REAL target (canonicalized), so navigation continues on real paths
    expect(link!.path.toLowerCase()).toBe(target.toLowerCase());
  });

  it("skips a broken symlink entry-level (listing still succeeds)", async () => {
    mkdirSync(join(base, "ok"));
    symlinkSync(join(base, "gone"), join(base, "dangling"), "junction");

    const res = await listDirs(base, deps());
    if (!res.ok) throw new Error("expected ok");
    expect(res.entries.map((e) => e.name)).toEqual(["ok"]);
  });

  it("rejects a relative path with invalid_path", async () => {
    const res = await listDirs("relative/path", deps());
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("rejects a nonexistent path with invalid_path (400, never 500)", async () => {
    const res = await listDirs(join(base, "does-not-exist"), deps());
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("rejects a file path with invalid_path", async () => {
    writeFileSync(join(base, "f.txt"), "x");
    const res = await listDirs(join(base, "f.txt"), deps());
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("returns parent for a nested dir and null parent at a filesystem root", async () => {
    mkdirSync(join(base, "child"));
    const res = await listDirs(join(base, "child"), deps());
    if (!res.ok) throw new Error("expected ok");
    expect(res.parent).toBe(base);
  });

  it("no path on win32 yields the injected roots view; no path elsewhere lists /", async () => {
    const res = await listDirs(undefined, {
      ...deps(),
      platform: "win32",
      listRoots: async () => [join(base) + "\\fake-root-not-checked"].slice(0, 0).concat([base]),
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.path).toBeNull();
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => e.path)).toEqual([base]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/fsbrowse/fsbrowse.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/fsbrowse/fsbrowse.ts`**

```ts
/**
 * Server-side folder browser for the New Project flow (spec §3e). Directories
 * ONLY — file names are never listed. Hardening per `[api/static-traversal]`:
 * the requested path is canonicalized via `realpath` before listing; a symlink/
 * junction entry is never followed silently — it is included ANNOTATED
 * (`isSymlink: true`) with `path` = its resolved REAL target, so navigation
 * always continues on canonical paths. Trust model (spec §3e): full-disk
 * directory-NAME browsing is by design — the daemon is a localhost,
 * single-operator tool bound to loopback that already runs workers with the
 * operator's rights.
 */
import { readdir, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface FsDirEntry {
  name: string;
  /** Absolute path for the next `?path=` request. For a symlink/junction this is the resolved REAL target. */
  path: string;
  /** Has a `.git` entry (dir or file — worktrees/submodules use a `.git` file). */
  isGitRepo: boolean;
  isRegistered: boolean;
  /** Present (true) only when the entry is a symlink/junction whose target is a directory. */
  isSymlink?: boolean;
}

export type FsDirsResult =
  | { ok: true; path: string | null; parent: string | null; entries: FsDirEntry[] }
  | { ok: false; code: "invalid_path"; message: string };

export interface FsBrowseDeps {
  /** Registry membership check for the `isRegistered` badge (canonical-path compare). */
  isRegistered(absPath: string): Promise<boolean>;
  /** Roots for the no-path view. Default: A:–Z: drive scan on win32; unused elsewhere. */
  listRoots?: () => Promise<string[]>;
  /** Injectable for tests; default `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Drive scan: existsSync per letter — cheap, no child process, no WMI. */
async function defaultListRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (let c = 0x41; c <= 0x5a; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function annotate(
  name: string,
  absPath: string,
  isSymlink: boolean,
  deps: FsBrowseDeps,
): Promise<FsDirEntry> {
  return {
    name,
    path: absPath,
    isGitRepo: existsSync(join(absPath, ".git")),
    isRegistered: await deps.isRegistered(absPath),
    ...(isSymlink ? { isSymlink: true } : {}),
  };
}

/**
 * List the sub-directories of `rawPath` (absolute), or the roots view when
 * `rawPath` is undefined (win32: drive letters; POSIX: the contents of `/`).
 * Every failure of the WHOLE listing is a typed `invalid_path` (route → 400,
 * never 500 — spec §6); failures of a SINGLE entry skip that entry only.
 */
export async function listDirs(rawPath: string | undefined, deps: FsBrowseDeps): Promise<FsDirsResult> {
  const platform = deps.platform ?? process.platform;

  if (rawPath === undefined) {
    if (platform === "win32") {
      const roots = await (deps.listRoots ?? defaultListRoots)();
      const entries: FsDirEntry[] = [];
      for (const r of roots) {
        entries.push(await annotate(r, r, false, deps));
      }
      return { ok: true, path: null, parent: null, entries };
    }
    rawPath = "/";
  }

  if (!isAbsolute(rawPath)) {
    return { ok: false, code: "invalid_path", message: `path must be absolute: ${rawPath}` };
  }
  const canonical = await realpathSafe(rawPath);
  if (canonical === null) {
    return { ok: false, code: "invalid_path", message: `path does not exist or is not accessible: ${rawPath}` };
  }
  let st;
  try {
    st = await stat(canonical);
  } catch {
    return { ok: false, code: "invalid_path", message: `path is not accessible: ${rawPath}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, code: "invalid_path", message: `not a directory: ${rawPath}` };
  }

  let dirents;
  try {
    dirents = await readdir(canonical, { withFileTypes: true });
  } catch (err) {
    return { ok: false, code: "invalid_path", message: `cannot list directory: ${String(err)}` };
  }

  const entries: FsDirEntry[] = [];
  for (const d of dirents) {
    try {
      if (d.isDirectory()) {
        entries.push(await annotate(d.name, join(canonical, d.name), false, deps));
      } else if (d.isSymbolicLink()) {
        // Never follow silently (§3e): resolve the real target; include dir targets only, annotated.
        const target = await realpathSafe(join(canonical, d.name));
        if (target === null) continue; // dangling link
        const targetStat = await stat(target);
        if (!targetStat.isDirectory()) continue;
        entries.push(await annotate(d.name, target, true, deps));
      }
      // Anything else (file, fifo, socket): never listed.
    } catch {
      continue; // unreadable entry -> entry-level skip (§6)
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parentDir = dirname(canonical);
  return { ok: true, path: canonical, parent: parentDir === canonical ? null : parentDir, entries };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/fsbrowse/fsbrowse.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/fsbrowse/
git commit -m "feat(fsbrowse): dirs-only folder browser with git/registered badges and symlink annotation"
```

---

### Task 3: `src/registry/scaffold.ts` — `.autodev/` scaffolding

**Files:**
- Create: `src/registry/scaffold.ts`
- Create: `src/registry/scaffold.test.ts`

Contract (spec §5/§6): validate the form → YAML BEFORE any fs write (the emitted
YAML must round-trip through the real strict `HarnessConfigSchema`); create the
blackboard skeleton dirs; write `GOAL.md`/`INVARIANTS.md` stubs `wx` (existing files
never clobbered); append `.autodev/` to `.git/info/exclude` idempotently;
`config.yaml` written LAST with `wx`; a repo that already has
`.autodev/config.yaml` skips the whole scaffold.

- [ ] **Step 1: Write the failing tests**

Create `src/registry/scaffold.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { scaffoldProject, buildConfigYaml, ScaffoldConfigError, ScaffoldFormSchema } from "./scaffold.js";
import { loadConfig } from "../config/config.js";
import { parseInvariants } from "../gate/invariants.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "adh-scaf-"));
  mkdirSync(join(repo, ".git")); // a plain .git DIR by default
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("buildConfigYaml", () => {
  it("emits YAML that loads through the real strict schema (round-trip)", async () => {
    const text = buildConfigYaml(
      ScaffoldFormSchema.parse({
        gate: { checkCommand: "php -l src/x.php" },
        worktree: { provision: ["vendor"] },
        allowedBranchPattern: "^autodev/",
        roles: {
          worker: { adapter: "claude", ladder: ["sonnet"] },
          critic: { adapter: "codex", model: "gpt-5.5", effort: "high" },
        },
      }),
    );
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), text);
    const cfg = await loadConfig(repo); // throws if the emitted YAML is invalid
    expect(cfg.gate.checkCommand).toBe("php -l src/x.php");
    expect(cfg.worktree.provision).toEqual(["vendor"]);
    expect(cfg.roles.worker.ladder).toEqual(["sonnet"]);
    expect(cfg.roles.critic.model).toBe("gpt-5.5");
    expect(cfg.contract.invariantsFile).toBe(".autodev/INVARIANTS.md");
    expect(cfg.contract.guardsFile).toBe(".autodev/GUARDS.md");
  });

  it("an empty form still emits a loadable config (defaults + contract paths)", async () => {
    const text = buildConfigYaml(ScaffoldFormSchema.parse({}));
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), text);
    const cfg = await loadConfig(repo);
    expect(cfg.stateDir).toBe(".autodev");
  });

  it("rejects form values the harness schema rejects (empty ladder) with ScaffoldConfigError", () => {
    expect(() => buildConfigYaml(ScaffoldFormSchema.parse({ roles: { worker: { ladder: [] } } }))).toThrow(
      ScaffoldConfigError,
    );
  });

  it("rejects a provision entry with a separator (schema superRefine) with ScaffoldConfigError", () => {
    expect(() =>
      buildConfigYaml(ScaffoldFormSchema.parse({ worktree: { provision: ["a/b"] } })),
    ).toThrow(ScaffoldConfigError);
  });
});

describe("scaffoldProject", () => {
  it("creates the full skeleton on a fresh repo: queue dirs, runtime, escalations, runs, worktrees, stubs, config", async () => {
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    expect(res.skipped).toBe(false);

    for (const q of ["pending", "active", "done", "escalated", "quarantine"]) {
      expect(existsSync(join(repo, ".autodev", "queue", q))).toBe(true);
    }
    for (const d of ["runtime", "escalations", "runs", "worktrees"]) {
      expect(existsSync(join(repo, ".autodev", d))).toBe(true);
    }
    expect(existsSync(join(repo, ".autodev", "GOAL.md"))).toBe(true);
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true);
  });

  it("the scaffolded INVARIANTS.md stub parses via parseInvariants with zero zones", async () => {
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const inv = parseInvariants(readFileSync(join(repo, ".autodev", "INVARIANTS.md"), "utf8"));
    expect(inv.contract_zones).toEqual([]);
    expect(inv.constitution.path_globs).toEqual([]);
  });

  it("the scaffolded config round-trips through loadConfig (strict schema passes)", async () => {
    await scaffoldProject(
      repo,
      ScaffoldFormSchema.parse({ gate: { checkCommand: "npm test" } }),
    );
    const cfg = await loadConfig(repo);
    expect(cfg.gate.checkCommand).toBe("npm test");
  });

  it("appends .autodev/ to .git/info/exclude exactly once (idempotent)", async () => {
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".autodev/");

    // Second scaffold on the same repo: skipped, and no duplicate line
    const res2 = await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    expect(res2.skipped).toBe(true);
    const again = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(again.split(/\r?\n/).filter((l) => l.trim() === ".autodev/").length).toBe(1);
  });

  it("preserves existing content in .git/info/exclude, appending with a clean newline", async () => {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), "node_modules/"); // note: no trailing newline
    await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("node_modules/");
    expect(exclude.split(/\r?\n/).map((l) => l.trim())).toContain(".autodev/");
  });

  it("skips entirely (config.yaml untouched) when .autodev/config.yaml already exists", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "# operator's own config\n");
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({ gate: { checkCommand: "x" } }));
    expect(res.skipped).toBe(true);
    expect(readFileSync(join(repo, ".autodev", "config.yaml"), "utf8")).toBe("# operator's own config\n");
  });

  it("never clobbers an existing GOAL.md / INVARIANTS.md (partial .autodev without config.yaml)", async () => {
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "GOAL.md"), "MY GOAL — do not touch\n");
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({}));
    expect(res.skipped).toBe(false); // no config.yaml -> scaffold proceeds
    expect(readFileSync(join(repo, ".autodev", "GOAL.md"), "utf8")).toBe("MY GOAL — do not touch\n");
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true); // still written
  });

  it("writes NOTHING when the form is invalid (config validated before any fs write)", async () => {
    // Bypass ScaffoldFormSchema deliberately to hit buildConfigYaml's round-trip guard:
    await expect(
      scaffoldProject(repo, { roles: { worker: { ladder: [] } } } as never),
    ).rejects.toThrow(ScaffoldConfigError);
    expect(existsSync(join(repo, ".autodev"))).toBe(false);
  });

  it("skips the exclude append with a WARN when .git is a FILE (worktree/submodule)", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    writeFileSync(join(repo, ".git"), "gitdir: ../elsewhere\n");
    const logs: string[] = [];
    const res = await scaffoldProject(repo, ScaffoldFormSchema.parse({}), (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(res.skipped).toBe(false);
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true);
    expect(logs.some((l) => l.startsWith("WARN:"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/registry/scaffold.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/registry/scaffold.ts`**

```ts
/**
 * `.autodev/` scaffolding for the New Project flow (spec §5). Transactional-ish
 * discipline (spec §6): the config YAML is built AND validated (round-trip
 * through the real strict `HarnessConfigSchema`) BEFORE any fs write; stub
 * files are written `wx` with EEXIST-skip so an existing blackboard file is
 * NEVER clobbered; `config.yaml` is written LAST with `wx` (mirrors
 * `enqueue.ts`/`recordRun` exclusivity).
 *
 * Layout mirrors the live-proven aurora `.autodev/` + the PS-oracle convention
 * of contract files living INSIDE `.autodev/` (real woodev `.autodev/` holds
 * GOAL.md/INVARIANTS.md/GUARDS.md). The scaffolded config points
 * `contract.invariantsFile`/`guardsFile` at those stubs so they are live.
 */
import { mkdir, writeFile, readFile, appendFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { HarnessConfigSchema } from "../config/schema.js";

type Log = (level: string, message: string) => void;

/** The registration-form surface (spec §5): roles, gate command, provision list,
 *  branch pattern. `.strict()` so an unknown key from the UI is a loud 400, not
 *  silently dropped (same philosophy as the root config schema). */
export const ScaffoldFormSchema = z
  .object({
    gate: z.object({ checkCommand: z.string().min(1).optional() }).strict().optional(),
    worktree: z.object({ provision: z.array(z.string()).optional() }).strict().optional(),
    allowedBranchPattern: z.string().min(1).optional(),
    roles: z
      .object({
        orchestrator: z
          .object({ adapter: z.string().optional(), model: z.string().optional(), effort: z.string().optional() })
          .strict()
          .optional(),
        worker: z
          .object({ adapter: z.string().optional(), ladder: z.array(z.string()).optional() })
          .strict()
          .optional(),
        critic: z
          .object({ adapter: z.string().optional(), model: z.string().optional(), effort: z.string().optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ScaffoldForm = z.infer<typeof ScaffoldFormSchema>;

/** Thrown when the form produces a config the harness schema rejects. Callers
 *  (admin) map this to a 400 `invalid_config`, distinct from real fs failures. */
export class ScaffoldConfigError extends Error {}

const CONFIG_HEADER =
  "# Autodev Harness — per-project config. Scaffolded by the New Project flow; edit freely.\n" +
  "# Contract stubs live under .autodev/ (see contract.invariantsFile / guardsFile below).\n";

const GOAL_STUB = [
  "# GOAL",
  "",
  "> Scaffolded by the autodev harness New Project flow. Replace with 3-5 lines",
  "> describing what this project is and why — the operator's immutable anchor.",
  "",
  "(describe the project goal here)",
  "",
].join("\n");

const INVARIANTS_STUB = [
  "# INVARIANTS",
  "",
  "> Contract zones for the machine gate. The harness reads the MACHINE-INVARIANTS",
  "> block below; empty zones = nothing enforced yet. Keep the markers intact.",
  "",
  "<!-- BEGIN MACHINE-INVARIANTS -->",
  "```json",
  JSON.stringify({ version: 1, updated: "", contract_zones: [], constitution: { path_globs: [] } }, null, 2),
  "```",
  "<!-- END MACHINE-INVARIANTS -->",
  "",
].join("\n");

const QUEUE_STATES = ["pending", "active", "done", "escalated", "quarantine"] as const;
const STATE_DIRS = ["runtime", "escalations", "runs", "worktrees"] as const;

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * Build the config.yaml text from the form and PROVE it loads: the emitted text
 * is parsed back and validated against the real strict `HarnessConfigSchema`,
 * so a scaffolded project can never fail its first `loadConfig`
 * (`[config/zod-strict]`: the strict root would otherwise fail loud at first use).
 */
export function buildConfigYaml(form: ScaffoldForm): string {
  const roles: Record<string, unknown> = {};
  if (form.roles?.orchestrator !== undefined) roles["orchestrator"] = pruneUndefined(form.roles.orchestrator);
  if (form.roles?.worker !== undefined) roles["worker"] = pruneUndefined(form.roles.worker);
  if (form.roles?.critic !== undefined) roles["critic"] = pruneUndefined(form.roles.critic);

  const cfg: Record<string, unknown> = {
    contract: { invariantsFile: ".autodev/INVARIANTS.md", guardsFile: ".autodev/GUARDS.md" },
  };
  if (form.allowedBranchPattern !== undefined) cfg["allowedBranchPattern"] = form.allowedBranchPattern;
  if (form.gate?.checkCommand !== undefined) cfg["gate"] = { checkCommand: form.gate.checkCommand };
  if (form.worktree?.provision !== undefined && form.worktree.provision.length > 0) {
    cfg["worktree"] = { provision: form.worktree.provision };
  }
  if (Object.keys(roles).length > 0) cfg["roles"] = roles;

  const text = CONFIG_HEADER + stringifyYaml(cfg);

  const parsed = HarnessConfigSchema.safeParse(parseYaml(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new ScaffoldConfigError(`scaffolded config.yaml would not load: ${issues}`);
  }
  return text;
}

/** `writeFile` with `wx`; EEXIST -> false (existing file NEVER clobbered — spec §6). */
async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Append `.autodev/` to `.git/info/exclude` once. A `.git` FILE (worktree/
 *  submodule) skips with a WARN — never fails registration over it. */
async function ensureGitExclude(repoRoot: string, log?: Log): Promise<void> {
  const gitDir = join(repoRoot, ".git");
  let st;
  try {
    st = await stat(gitDir);
  } catch {
    return; // validated upstream (admin requires .git); stay lenient here
  }
  if (!st.isDirectory()) {
    log?.(
      "WARN",
      `scaffold: ${gitDir} is not a directory (worktree/submodule?) — add .autodev/ to its exclude file manually`,
    );
    return;
  }
  const infoDir = join(gitDir, "info");
  await mkdir(infoDir, { recursive: true });
  const excludePath = join(infoDir, "exclude");
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing.split(/\r?\n/).some((l) => l.trim() === ".autodev/")) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(excludePath, `${prefix}# autodev harness state (added by the New Project scaffold)\n.autodev/\n`, "utf8");
}

export interface ScaffoldResult {
  /** True when `.autodev/config.yaml` already existed — nothing was touched. */
  skipped: boolean;
  /** Repo-relative paths of files this call actually wrote (dirs not tracked). */
  written: string[];
}

/**
 * Scaffold `.autodev/` into `repoRoot`. Skips entirely when
 * `.autodev/config.yaml` exists (spec §5: registering a repo that already has
 * one shows its values instead). Order: validate config text (no writes on a
 * bad form) → mkdir skeleton → stubs (`wx`, EEXIST-skip) → git exclude →
 * config.yaml LAST (`wx`).
 */
export async function scaffoldProject(repoRoot: string, form: ScaffoldForm, log?: Log): Promise<ScaffoldResult> {
  const autodevDir = join(repoRoot, ".autodev");
  const configPath = join(autodevDir, "config.yaml");
  if (existsSync(configPath)) return { skipped: true, written: [] };

  const yamlText = buildConfigYaml(form); // throws ScaffoldConfigError BEFORE any fs write

  const written: string[] = [];
  for (const state of QUEUE_STATES) await mkdir(join(autodevDir, "queue", state), { recursive: true });
  for (const d of STATE_DIRS) await mkdir(join(autodevDir, d), { recursive: true });

  if (await writeIfAbsent(join(autodevDir, "GOAL.md"), GOAL_STUB)) written.push(".autodev/GOAL.md");
  if (await writeIfAbsent(join(autodevDir, "INVARIANTS.md"), INVARIANTS_STUB)) written.push(".autodev/INVARIANTS.md");

  await ensureGitExclude(repoRoot, log);

  await writeFile(configPath, yamlText, { flag: "wx" }); // LAST + exclusive (spec §6)
  written.push(".autodev/config.yaml");
  return { skipped: false, written };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/registry/scaffold.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/registry/scaffold.ts src/registry/scaffold.test.ts
git commit -m "feat(registry): .autodev scaffold — validated config, wx stubs, git-exclude append"
```

---

### Task 4: `src/registry/admin.ts` — register / unregister behind a mutex

**Files:**
- Create: `src/registry/admin.ts`
- Create: `src/registry/admin.test.ts`

Contract (spec §5/§6): `register` validates (path exists + is dir → is a git repo →
not already registered), optionally scaffolds (default ON), then appends to the
registry — so a failed scaffold never leaves a registry entry. `unregister` removes
the entry only, never touching the folder. All registry read-modify-writes are
serialized (two concurrent registers must not lose a write). Typed error codes map
to HTTP statuses in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `src/registry/admin.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectAdmin } from "./admin.js";
import { loadRegistry } from "./registry.js";

let base: string;
let registryFile: string;

/** A minimal fake git repo dir. */
function makeRepo(name: string): string {
  const p = join(base, name);
  mkdirSync(join(p, ".git"), { recursive: true });
  return p;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "adh-admin-"));
  registryFile = join(base, "registry", "projects.json");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("createProjectAdmin / register", () => {
  it("registers a valid git repo: entry saved, .autodev scaffolded by default", async () => {
    const repo = makeRepo("app");
    const admin = createProjectAdmin({ registryFile });

    const res = await admin.register({ path: repo });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entry.id).toBe("app");
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true);

    const reg = await loadRegistry(registryFile);
    expect(reg.projects.map((p) => p.id)).toEqual(["app"]);
  });

  it("scaffold: false registers without touching the repo", async () => {
    const repo = makeRepo("bare");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, scaffold: false });
    expect(res.ok).toBe(true);
    expect(existsSync(join(repo, ".autodev"))).toBe(false);
  });

  it("passes the config form through to the scaffolded config.yaml", async () => {
    const repo = makeRepo("cfg");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, config: { gate: { checkCommand: "npm test" } } });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(repo, ".autodev", "config.yaml"), "utf8")).toContain("npm test");
  });

  it("rejects a nonexistent path with invalid_path", async () => {
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: join(base, "nope") });
    expect(res).toMatchObject({ ok: false, code: "invalid_path" });
  });

  it("rejects a non-git dir with not_a_git_repo", async () => {
    const p = join(base, "plain");
    mkdirSync(p);
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: p });
    expect(res).toMatchObject({ ok: false, code: "not_a_git_repo" });
  });

  it("rejects a duplicate path with already_registered (second call, same canonical path)", async () => {
    const repo = makeRepo("dup");
    const admin = createProjectAdmin({ registryFile });
    expect((await admin.register({ path: repo })).ok).toBe(true);
    const res = await admin.register({ path: repo });
    expect(res).toMatchObject({ ok: false, code: "already_registered" });
  });

  it("rejects an invalid config form with invalid_config and does NOT register", async () => {
    const repo = makeRepo("badcfg");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, config: { roles: { worker: { ladder: [] } } } });
    expect(res).toMatchObject({ ok: false, code: "invalid_config" });
    expect((await loadRegistry(registryFile)).projects).toEqual([]);
    expect(existsSync(join(repo, ".autodev"))).toBe(false); // scaffold wrote nothing
  });

  it("rejects an unknown config key with invalid_config (strict form)", async () => {
    const repo = makeRepo("unknownkey");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo, config: { totallyUnknown: 1 } });
    expect(res).toMatchObject({ ok: false, code: "invalid_config" });
  });

  it("registers a repo that already has .autodev/config.yaml WITHOUT clobbering it (scaffold self-skips)", async () => {
    const repo = makeRepo("existing");
    mkdirSync(join(repo, ".autodev"), { recursive: true });
    writeFileSync(join(repo, ".autodev", "config.yaml"), "# mine\n");
    const admin = createProjectAdmin({ registryFile });
    const res = await admin.register({ path: repo });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(repo, ".autodev", "config.yaml"), "utf8")).toBe("# mine\n");
  });

  it("two CONCURRENT registers of different repos both land (mutex — no lost write)", async () => {
    const r1 = makeRepo("one");
    const r2 = makeRepo("two");
    const admin = createProjectAdmin({ registryFile });
    const [a, b] = await Promise.all([admin.register({ path: r1 }), admin.register({ path: r2 })]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const reg = await loadRegistry(registryFile);
    expect(reg.projects.map((p) => p.id).sort()).toEqual(["one", "two"]);
  });

  it("two CONCURRENT registers of the SAME repo: exactly one wins", async () => {
    const repo = makeRepo("race");
    const admin = createProjectAdmin({ registryFile });
    const results = await Promise.all([admin.register({ path: repo }), admin.register({ path: repo })]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.code === "already_registered").length).toBe(1);
    expect((await loadRegistry(registryFile)).projects.length).toBe(1);
  });
});

describe("createProjectAdmin / unregister", () => {
  it("removes the entry and returns true; the project folder is untouched", async () => {
    const repo = makeRepo("gone");
    const admin = createProjectAdmin({ registryFile });
    const reg = await admin.register({ path: repo });
    if (!reg.ok) throw new Error("register failed");

    expect(await admin.unregister(reg.entry.id)).toBe(true);
    expect((await loadRegistry(registryFile)).projects).toEqual([]);
    expect(existsSync(join(repo, ".autodev", "config.yaml"))).toBe(true); // folder untouched
  });

  it("returns false for an unknown id", async () => {
    const admin = createProjectAdmin({ registryFile });
    expect(await admin.unregister("nope")).toBe(false);
  });
});

describe("createProjectAdmin / isRegistered", () => {
  it("reflects registry membership by canonical path", async () => {
    const repo = makeRepo("member");
    const admin = createProjectAdmin({ registryFile });
    expect(await admin.isRegistered(repo)).toBe(false);
    await admin.register({ path: repo });
    expect(await admin.isRegistered(repo)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/registry/admin.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/registry/admin.ts`**

```ts
/**
 * Project admin for the New Project flow (spec §5/§6): register (validate →
 * scaffold → registry append), unregister (registry entry ONLY — never touches
 * the project folder), and the registry-membership check the folder browser
 * annotates with. Every registry read-modify-write runs through a promise-chain
 * mutex: the registry is a single JSON file with plain-overwrite saves, so two
 * concurrent POST /projects handled without serialization would race
 * (last-writer-wins) and silently lose one entry.
 */
import { stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadRegistry,
  saveRegistry,
  addProject,
  removeProject,
  isPathRegistered,
  type RegistryEntry,
} from "./registry.js";
import { scaffoldProject, ScaffoldConfigError, ScaffoldFormSchema } from "./scaffold.js";

type Log = (level: string, message: string) => void;

export interface RegisterInput {
  path: string;
  name?: string;
  /** Default true (spec §5: scaffold checkbox default ON). Safe: scaffold
   *  self-skips when `.autodev/config.yaml` already exists. */
  scaffold?: boolean;
  /** Raw form values from the HTTP body — validated here via `ScaffoldFormSchema`. */
  config?: unknown;
}

export type RegisterErrorCode = "invalid_path" | "not_a_git_repo" | "already_registered" | "invalid_config";

export type RegisterResult =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; code: RegisterErrorCode; message: string };

export interface ProjectAdmin {
  register(input: RegisterInput): Promise<RegisterResult>;
  /** True when removed; false for an unknown id. Registry entry only. */
  unregister(id: string): Promise<boolean>;
  /** Registry membership by canonical path (folder-browser badge). */
  isRegistered(absPath: string): Promise<boolean>;
}

export function createProjectAdmin(deps: { registryFile: string; log?: Log }): ProjectAdmin {
  // Promise-chain mutex. `chain` is always a settled-or-pending SWALLOWED promise
  // (never rejected), so one failed operation can never wedge the queue.
  let chain: Promise<void> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    register(input) {
      return withLock(async (): Promise<RegisterResult> => {
        // 1. Path exists (realpath canonicalizes: a symlink alias of a registered
        //    repo hits the SAME canonical key) and is a directory.
        let real: string;
        try {
          real = await realpath(input.path);
        } catch {
          return { ok: false, code: "invalid_path", message: `path does not exist: ${input.path}` };
        }
        let st;
        try {
          st = await stat(real);
        } catch {
          return { ok: false, code: "invalid_path", message: `path is not accessible: ${input.path}` };
        }
        if (!st.isDirectory()) {
          return { ok: false, code: "invalid_path", message: `not a directory: ${input.path}` };
        }

        // 2. Is a git repo (a `.git` dir OR file — worktrees/submodules use a file).
        if (!existsSync(join(real, ".git"))) {
          return { ok: false, code: "not_a_git_repo", message: `not a git repository (no .git): ${real}` };
        }

        // 3. Not already registered (canonical-path compare, win32 case-fold).
        const registry = await loadRegistry(deps.registryFile, deps.log);
        if (isPathRegistered(registry, real)) {
          return { ok: false, code: "already_registered", message: `path already registered: ${real}` };
        }

        // 4. Scaffold BEFORE the registry append: a failed scaffold must never
        //    leave a registered project pointing at a half-initialized repo.
        if (input.scaffold !== false) {
          const form = ScaffoldFormSchema.safeParse(input.config ?? {});
          if (!form.success) {
            const issues = form.error.issues
              .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
              .join("; ");
            return { ok: false, code: "invalid_config", message: `invalid config form: ${issues}` };
          }
          try {
            await scaffoldProject(real, form.data, deps.log);
          } catch (err) {
            if (err instanceof ScaffoldConfigError) {
              return { ok: false, code: "invalid_config", message: err.message };
            }
            throw err; // real fs failure -> route's top-level catch -> 500
          }
        }

        // 5. Registry append + save (inside the same lock as the load above).
        const { registry: updated, entry } = addProject(registry, {
          path: real,
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        await saveRegistry(deps.registryFile, updated);
        deps.log?.("INFO", `admin: registered project '${entry.id}' at ${entry.path}`);
        return { ok: true, entry };
      });
    },

    unregister(id) {
      return withLock(async () => {
        const registry = await loadRegistry(deps.registryFile, deps.log);
        if (!registry.projects.some((p) => p.id === id)) return false;
        await saveRegistry(deps.registryFile, removeProject(registry, id));
        deps.log?.("INFO", `admin: unregistered project '${id}' (registry entry only, folder untouched)`);
        return true;
      });
    },

    async isRegistered(absPath) {
      const registry = await loadRegistry(deps.registryFile, deps.log);
      return isPathRegistered(registry, absPath);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/registry/admin.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/registry/admin.ts src/registry/admin.test.ts
git commit -m "feat(registry): project admin — register/unregister/isRegistered behind a write mutex"
```

---

### Task 5: API routes — `GET /fs/dirs`, `POST /projects`, `DELETE /projects/:id`

**Files:**
- Modify: `src/api/server.ts`
- Modify: `src/api/server.test.ts`

Routes go through a new OPTIONAL `deps.admin` port (mirrors `onOrchestrate`: absent
→ 404, read-only deployment). `DELETE /projects/:id` is handled BEFORE the project
root is resolved (a project whose config is broken — hub `{error}` → 503 — must
still be deletable) and closes any live watcher for that id. `POST /projects` reuses
the existing `readJsonBody` + 413 teardown pattern.

- [ ] **Step 1: Write the failing tests**

Append to `src/api/server.test.ts`:

```ts
import type { RegisterResult } from "../registry/admin.js";
import type { FsDirsResult } from "../fsbrowse/fsbrowse.js";

/** Fake admin port capturing calls; per-test overrides via the ctor arg. */
function fakeAdmin(overrides: Partial<NonNullable<ApiServerDeps["admin"]>> = {}) {
  const calls: { register: unknown[]; unregister: string[]; listDirs: (string | undefined)[] } = {
    register: [],
    unregister: [],
    listDirs: [],
  };
  const admin: NonNullable<ApiServerDeps["admin"]> = {
    register: async (input) => {
      calls.register.push(input);
      return { ok: true, entry: { id: "new-proj", name: "new-proj", path: String((input as { path: string }).path) } };
    },
    unregister: async (id) => {
      calls.unregister.push(id);
      return id === "p1";
    },
    listDirs: async (path) => {
      calls.listDirs.push(path);
      return { ok: true, path: path ?? null, parent: null, entries: [] } satisfies FsDirsResult;
    },
    ...overrides,
  };
  return { admin, calls };
}

describe("GET /fs/dirs", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs`);
    expect(res.status).toBe(404);
  });

  it("passes the decoded ?path= through and returns the listing", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs?path=${encodeURIComponent("D:\\Projects")}`);
    expect(res.status).toBe(200);
    expect(calls.listDirs).toEqual(["D:\\Projects"]);
    const body = (await res.json()) as { path: string | null; entries: unknown[] };
    expect(body.path).toBe("D:\\Projects");
  });

  it("omits path when the param is absent (roots view)", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs`);
    expect(res.status).toBe(200);
    expect(calls.listDirs).toEqual([undefined]);
  });

  it("maps invalid_path to 400, never 500", async () => {
    const { admin } = fakeAdmin({
      listDirs: async () => ({ ok: false, code: "invalid_path", message: "nope" }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/dirs?path=zzz`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("nope");
  });
});

describe("POST /projects", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:/x" }),
    });
    expect(res.status).toBe(404);
  });

  it("registers and returns 201 with the entry", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:/Projects/app", name: "App", scaffold: true, config: { gate: { checkCommand: "npm test" } } }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { id: string }).toMatchObject({ id: "new-proj" });
    expect(calls.register[0]).toMatchObject({ path: "D:/Projects/app", name: "App", scaffold: true });
  });

  it("400s a missing/empty path before calling the port", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    for (const body of [{}, { path: "" }, { path: 42 }]) {
      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(calls.register).toEqual([]);
  });

  it("maps already_registered to 409 and invalid_path/not_a_git_repo/invalid_config to 400", async () => {
    const cases: Array<{ code: RegisterResult extends { ok: false; code: infer C } ? C : never; status: number }> = [
      { code: "already_registered", status: 409 },
      { code: "invalid_path", status: 400 },
      { code: "not_a_git_repo", status: 400 },
      { code: "invalid_config", status: 400 },
    ] as never;
    for (const c of cases) {
      const { admin } = fakeAdmin({
        register: async () => ({ ok: false, code: c.code, message: "m" }) as RegisterResult,
      });
      const h = createApiServer(projectDeps({ repo, stateDir }, { admin }));
      const port = await h.listen(0);
      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "D:/x" }),
      });
      expect(res.status).toBe(c.status);
      await h.close();
    }
  });

  it("rejects invalid JSON with 400", async () => {
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /projects/:id", () => {
  it("unregisters a known id -> 200; unknown id -> 404", async () => {
    const { admin, calls } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);

    const ok = await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { removed: string }).toMatchObject({ removed: "p1" });

    const missing = await fetch(`http://127.0.0.1:${port}/projects/ghost`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(calls.unregister).toEqual(["p1", "ghost"]);
  });

  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("works even when the project root would fail to build (never resolves the root)", async () => {
    const { admin } = fakeAdmin();
    const deps: ApiServerDeps = {
      projects: {
        list: async () => [],
        get: async () => ({ error: "broken config" }), // GET-path would 503
      },
      admin,
    };
    handle = createApiServer(deps);
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(res.status).toBe(200); // DELETE never called projects.get
  });

  it("closes a live watcher for the removed project id", async () => {
    let closed = 0;
    const fakeWatchFactory = (_sd: string, _onChange: (p: string) => void) => ({
      close: () => {
        closed++;
      },
    });
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin, watchFactory: fakeWatchFactory }));
    const port = await handle.listen(0);

    // Attach the watcher by touching any project-scoped GET route.
    await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
    expect(closed).toBe(0);

    await fetch(`http://127.0.0.1:${port}/projects/p1`, { method: "DELETE" });
    expect(closed).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api/server.test.ts`
Expected: FAIL — `admin` is not a known dep / routes 404 where 200/201 expected.
(The pre-existing tests must still pass.)

- [ ] **Step 3: Implement the routes in `src/api/server.ts`**

3a. Add the type imports near the other imports:

```ts
import type { RegisterInput, RegisterResult } from "../registry/admin.js";
import type { FsDirsResult } from "../fsbrowse/fsbrowse.js";
```

3b. Extend `ApiServerDeps` (after the `uiDir` member):

```ts
  /**
   * OPTIONAL project-admin port (New Project flow, spec §3c/§5). When unset the
   * three admin routes (`GET /fs/dirs`, `POST /projects`, `DELETE /projects/:id`)
   * respond 404 — a read-only deployment, mirroring `onOrchestrate`'s pattern.
   * The server never touches the registry or the filesystem itself; it only
   * validates request shape and maps the port's typed results to HTTP statuses.
   */
  admin?: {
    register(input: RegisterInput): Promise<RegisterResult>;
    unregister(id: string): Promise<boolean>;
    listDirs(path?: string): Promise<FsDirsResult>;
  };
```

3c. Add two handlers inside `createApiServer` (near `handleOrchestrate`):

```ts
  /** GET /fs/dirs?path=<abs> — folder browser (spec §3e). Whole-listing failures
   *  are 400 (typed invalid_path from the port), never 500 (spec §6). */
  async function handleFsDirs(url: URL, res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const pathParam = url.searchParams.get("path");
    const result = await deps.admin.listDirs(pathParam === null || pathParam === "" ? undefined : pathParam);
    if (!result.ok) {
      sendJson(res, 400, { error: result.message });
      return;
    }
    sendJson(res, 200, { path: result.path, parent: result.parent, entries: result.entries });
  }

  /** POST /projects — register (+ optional scaffold). Validation beyond request
   *  SHAPE lives in the admin port; this handler only maps typed codes to HTTP. */
  async function handleRegisterProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Same 413 + teardown pattern as handleReply -- see `[api/413-teardown]`.
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const parsed = body as { path?: unknown; name?: unknown; scaffold?: unknown; config?: unknown } | null;
    if (typeof parsed?.path !== "string" || parsed.path.trim() === "") {
      sendJson(res, 400, { error: "path must be a non-empty string" });
      return;
    }
    if (parsed.name !== undefined && typeof parsed.name !== "string") {
      sendJson(res, 400, { error: "name must be a string" });
      return;
    }
    if (parsed.scaffold !== undefined && typeof parsed.scaffold !== "boolean") {
      sendJson(res, 400, { error: "scaffold must be a boolean" });
      return;
    }
    // `config` stays unknown here — the admin port validates it (ScaffoldFormSchema)
    // and reports a typed invalid_config, keeping one source of truth for the form.

    const result = await deps.admin.register({
      path: parsed.path,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.scaffold !== undefined ? { scaffold: parsed.scaffold } : {}),
      ...(parsed.config !== undefined ? { config: parsed.config } : {}),
    });
    if (result.ok) {
      log("INFO", `api: registered project '${result.entry.id}' at ${flattenForLog(result.entry.path)}`);
      sendJson(res, 201, result.entry);
      return;
    }
    sendJson(res, result.code === "already_registered" ? 409 : 400, {
      error: result.message,
      code: result.code,
    });
  }
```

3d. Wire the routes in `handleRequest`. Add the `/fs/dirs` and `POST /projects`
branches next to the existing daemon-global `GET /projects` branch:

```ts
    // Daemon-global: the sidebar project list. Never per-project.
    if (req.method === "GET" && (url.pathname === "/projects" || url.pathname === "/projects/")) {
      sendJson(res, 200, { projects: await deps.projects.list() });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/projects" || url.pathname === "/projects/")) {
      return void (await handleRegisterProject(req, res));
    }
    if (req.method === "GET" && (url.pathname === "/fs/dirs" || url.pathname === "/fs/dirs/")) {
      return void (await handleFsDirs(url, res));
    }
```

3e. Inside the `projMatch` block, handle DELETE BEFORE resolving the project (a
broken-config project must still be deletable — resolving would 503). Insert right
after the `rawPid` validation, before `deps.projects.get(rawPid)`:

```ts
      const sub = projMatch[2] ?? "/";

      // DELETE /projects/:id — registry-entry removal only (spec §3a: never touches
      // the folder). Handled BEFORE the root resolve: a project whose config fails
      // to build (hub {error} -> 503 on GET routes) must still be deletable. Also
      // closes this id's live watcher so a later re-registration under the same id
      // can never receive stale broadcasts ([multiproject/id-keyed-caches]).
      if (req.method === "DELETE" && (sub === "/" || sub === "")) {
        if (!deps.admin) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const removed = await deps.admin.unregister(rawPid);
        if (!removed) {
          sendJson(res, 404, { error: "project not found" });
          return;
        }
        const w = watchers.get(rawPid);
        if (w) {
          void Promise.resolve(w.handle.close()).catch(() => {});
          watchers.delete(rawPid);
        }
        log("INFO", `api: unregistered project '${rawPid}'`);
        sendJson(res, 200, { removed: rawPid });
        return;
      }
```

…and delete the now-duplicated `const sub = projMatch[2] ?? "/";` line further down
(the one that previously sat after `ensureWatcher`).

- [ ] **Step 4: Run the API tests to verify they pass**

Run: `npx vitest run src/api/server.test.ts`
Expected: PASS (all pre-existing + ~14 new).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/api/server.ts src/api/server.test.ts
git commit -m "feat(api): admin routes — GET /fs/dirs, POST /projects, DELETE /projects/:id"
```

---

### Task 6: Wire the real admin into `serve` + full verification

**Files:**
- Modify: `src/index.ts` (untested glue, same status as the rest of the composition root)

- [ ] **Step 1: Wire `createProjectAdmin` + `listDirs` in the `serve` branch of `src/index.ts`**

Add imports:

```ts
import { createProjectAdmin } from "./registry/admin.js";
import { listDirs } from "./fsbrowse/fsbrowse.js";
```

In the `serve` branch, after `const hub = createProjectHub…`, add:

```ts
    const admin = createProjectAdmin({ registryFile, log });
```

And extend the `createApiServer({...})` call with the port:

```ts
      admin: {
        register: (input) => admin.register(input),
        unregister: (id) => admin.unregister(id),
        listDirs: (path) => listDirs(path, { isRegistered: (abs) => admin.isRegistered(abs) }),
      },
```

- [ ] **Step 2: Full verification**

```bash
npm run typecheck
npm test
npm run build
```

Expected: typecheck clean; full suite green (537 pre-existing + ~39 new); build OK.

- [ ] **Step 3: Smoke the daemon manually (fast, no project needed)**

```bash
AUTODEV_REGISTRY=$(mktemp -d)/projects.json node dist/index.js serve --port 43190 &
sleep 1
curl -s "http://127.0.0.1:43190/fs/dirs" | head -c 300
curl -s -X POST "http://127.0.0.1:43190/projects" -H "content-type: application/json" -d '{"path":"Z:/definitely/missing"}'
kill %1
```

Expected: first curl returns a JSON roots listing; second returns
`{"error":"path does not exist: ...","code":"invalid_path"}` with status 400.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(serve): wire project admin + folder browser into the daemon"
```

---

### Task 7: Codex GPT-5.5 gate (process step — run by the orchestrating session)

- [ ] Produce the M3 diff (`git diff main...HEAD`) + review prompt → file → `codex exec`
      per the s17 protocol (inline diff, read-only, effort high).
- [ ] Every finding: fix via a fix-subagent WITH a regression test, or decline with
      written rationale. Re-critic all fixes. Never self-certify.
- [ ] After `clean`: PR per AGENTS.md batch rule.

---

## Self-review notes (done at plan time)

- **Spec coverage:** §3c routes (POST/DELETE + /fs/dirs) → Tasks 4/5; §3e hardening
  (realpath canonicalization, lstat-equivalent dirent checks, annotated symlinks,
  entry-level skip, 400-never-500) → Task 2; §5 scaffold (form → config.yaml,
  skeleton, git-exclude, skip-existing, never-clobber) → Task 3; §6 error handling →
  Tasks 2/3/4/5 (typed codes, transactional-ish order, config-last-wx); §7 test plan
  items 5/6 → Tasks 2/3/4 tests. Registry reuse (`addProject`/`removeProject`/
  `saveRegistry` untouched) → Task 4 only composes them.
- **Not in scope (per spec §9 / CURRENT-STATE):** M4 UI shell, M5 theming, token
  stats, desktop wrap. The `GET /projects` list shape is unchanged.
- **Types cross-checked:** `FsDirsResult`/`FsDirEntry` (Tasks 2→5), `ScaffoldForm`/
  `ScaffoldConfigError` (Tasks 3→4), `RegisterInput`/`RegisterResult`/`ProjectAdmin`
  (Tasks 4→5→6), `isPathRegistered` (Tasks 1→4).
