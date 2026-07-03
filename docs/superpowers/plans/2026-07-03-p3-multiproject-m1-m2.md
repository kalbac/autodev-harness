# Multi-Project Daemon (M1–M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon serves N registered projects concurrently — global registry file, lazy per-project composition roots, all API routes re-rooted under `/projects/:id`, WS change events carry `projectId`, UI bundle resolved from the harness install (not the project tree).

**Architecture:** A thin identity-only registry (`~/.autodev/projects.json`) is loaded by a `ProjectHub` that lazily builds one composition root per project via `buildProjectRoot()` — the current `main()` wiring extracted into `src/composition/root.ts`. `createApiServer` stops taking a single `{repo, stateDir}` and instead takes a `projects` port (`list`/`get`); every handler becomes per-project; single-flight orchestrate becomes per-project; one fs-watcher per built project feeds `{type:"change", projectId, path}`. CLI verbs `run`/`orchestrate` stay cwd-bound (unchanged contract). Spec: `docs/superpowers/specs/2026-07-03-p3-multiproject-shell-design.md` §3.

**Tech Stack:** Node LTS + TypeScript (ESM, `.js` import paths, strict `NodeNext`, `exactOptionalPropertyTypes` — use conditional spreads for optional fields), zod NOT needed here (registry is hand-validated), vitest. Run `npm run typecheck` after every task (vitest does not typecheck — gotcha `[ts/typecheck-scope]`).

**Discipline reminder:** Tasks 1–8 are enforcement-adjacent backend → after Task 8 (code complete, typecheck + full suite green) run the **independent codex GPT-5.5 gate** on the whole diff (Task 9), fix findings with regression tests, **re-critic every fix**. Task 10 (UI shim) is presentation → review, not gate.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/registry/registry.ts` | load/save/add/remove registry entries; id slugs | CREATE |
| `src/registry/registry.test.ts` | registry tests | CREATE |
| `src/composition/root.ts` | `buildProjectRoot(repoRoot, opts)` — the extracted per-project wiring (cfg, repo, conductor, orchestrator) | CREATE (extraction, untested glue like `src/index.ts` — gotcha `[conductor/wiring]`) |
| `src/hub/hub.ts` | `createProjectHub` — lazy id→root map, error isolation | CREATE |
| `src/hub/hub.test.ts` | hub tests (fake buildRoot) | CREATE |
| `src/api/server.ts` | HTTP+WS server | MODIFY: `projects` port, route re-rooting, per-project single-flight + watchers |
| `src/api/server.test.ts` | server tests | MODIFY: `projectDeps` helper + URL prefix churn + new multi-project tests |
| `src/index.ts` | CLI entry | MODIFY: verbs use `buildProjectRoot`; `serve` uses registry+hub, module-relative uiDir, no cwd binding |
| `ui/src/**` (small) | existing dashboard | MODIFY (Task 10): default-project shim so the s14 UI keeps working until M4 |

Naming used consistently below: `RegistryEntry {id,name,path}`, `ProjectRoot`, `ProjectView {repo, stateDir, onOrchestrate?}`, `ProjectHub.list()/get()`.

---

## Task 1: Registry module

**Files:**
- Create: `src/registry/registry.ts`
- Test: `src/registry/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/registry/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, saveRegistry, addProject, removeProject, slugForName } from "./registry.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adh-registry-"));
  file = join(dir, "sub", "projects.json"); // parent dir does NOT exist yet
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadRegistry", () => {
  it("missing file -> empty registry, no throw", async () => {
    expect(await loadRegistry(file)).toEqual({ projects: [] });
  });

  it("round-trips through saveRegistry (creates parent dirs)", async () => {
    const reg = { projects: [{ id: "aurora", name: "aurora", path: "D:/Projects/aurora" }] };
    await saveRegistry(file, reg);
    expect(await loadRegistry(file)).toEqual(reg);
  });

  it("corrupt JSON -> empty registry + loud log, no throw", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(file, "{ nope", "utf8");
    const logs: string[] = [];
    const reg = await loadRegistry(file, (lvl, msg) => logs.push(`${lvl}:${msg}`));
    expect(reg).toEqual({ projects: [] });
    expect(logs.some((l) => l.startsWith("ERROR:"))).toBe(true);
  });

  it("valid JSON with wrong shape (entries missing fields) -> those entries dropped", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(file, JSON.stringify({ projects: [{ id: "ok", name: "ok", path: "/p" }, { id: 5 }, "x"] }), "utf8");
    const reg = await loadRegistry(file);
    expect(reg.projects).toEqual([{ id: "ok", name: "ok", path: "/p" }]);
  });
});

describe("slugForName", () => {
  it("kebab-cases and strips non-alphanumerics", () => {
    expect(slugForName("Woodev Framework!", [])).toBe("woodev-framework");
  });

  it("uniquifies with a numeric suffix on collision", () => {
    expect(slugForName("aurora", ["aurora"])).toBe("aurora-2");
    expect(slugForName("aurora", ["aurora", "aurora-2"])).toBe("aurora-3");
  });

  it("falls back to 'project' for a name with no usable characters", () => {
    expect(slugForName("!!!", [])).toBe("project");
  });
});

describe("addProject / removeProject (pure)", () => {
  it("addProject derives id from the folder name and appends", () => {
    const { registry, entry } = addProject({ projects: [] }, { path: "D:/Projects/My App" });
    expect(entry).toEqual({ id: "my-app", name: "My App", path: "D:/Projects/My App" });
    expect(registry.projects).toEqual([entry]);
  });

  it("addProject rejects an already-registered path", () => {
    const reg = { projects: [{ id: "a", name: "a", path: "D:/Projects/a" }] };
    expect(() => addProject(reg, { path: "D:/Projects/a" })).toThrow(/already registered/);
  });

  it("removeProject removes by id and is a no-op for unknown ids", () => {
    const reg = { projects: [{ id: "a", name: "a", path: "/a" }] };
    expect(removeProject(reg, "a").projects).toEqual([]);
    expect(removeProject(reg, "zz").projects).toEqual(reg.projects);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/registry/registry.test.ts`
Expected: FAIL — module `./registry.js` does not exist.

- [ ] **Step 3: Implement `src/registry/registry.ts`**

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** One registered project. Identity ONLY — all project truth (roles, gate,
 *  provision, …) stays in the project's own `.autodev/config.yaml`
 *  (spec §3a; frozen-skeleton axis 1: file-blackboard = truth). */
export interface RegistryEntry {
  /** Stable kebab-case slug; appears in URLs and WS events. Never changes after registration. */
  id: string;
  /** Display name (renameable). */
  name: string;
  /** Absolute path to the project repo root. */
  path: string;
}

export interface Registry {
  projects: RegistryEntry[];
}

type Log = (level: string, message: string) => void;

function isEntry(v: unknown): v is RegistryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.name === "string" && typeof e.path === "string";
}

/**
 * Load the registry. NEVER throws: a missing file is an empty registry; a
 * corrupt file is an empty registry + a loud ERROR log (spec §6 — `serve`
 * must not crash over a bad registry); malformed entries are dropped
 * individually so one bad entry can't hide the rest.
 */
export async function loadRegistry(file: string, log?: Log): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { projects: [] }; // missing (or unreadable) -> empty; registration recreates it
  }
  try {
    const parsed = JSON.parse(text) as { projects?: unknown };
    const raw = Array.isArray(parsed.projects) ? parsed.projects : [];
    return { projects: raw.filter(isEntry) };
  } catch (err) {
    log?.("ERROR", `registry: corrupt ${file} — starting with an empty registry (${String(err)})`);
    return { projects: [] };
  }
}

/** Write the registry, creating parent dirs. Plain overwrite — the registry is
 *  tiny, single-writer (the daemon), and identity-only; losing it is recoverable
 *  by re-registering. */
export async function saveRegistry(file: string, registry: Registry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

/** Kebab-case slug of `name`, uniquified against `taken` with `-2`, `-3`, … (spec §3a). */
export function slugForName(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Pure: append a new project (id derived from the folder name). Throws on a duplicate path. */
export function addProject(registry: Registry, input: { path: string; name?: string }): { registry: Registry; entry: RegistryEntry } {
  if (registry.projects.some((p) => p.path === input.path)) {
    throw new Error(`registry: path already registered: ${input.path}`);
  }
  const name = input.name ?? basename(input.path);
  const id = slugForName(name, registry.projects.map((p) => p.id));
  const entry: RegistryEntry = { id, name, path: input.path };
  return { registry: { projects: [...registry.projects, entry] }, entry };
}

/** Pure: remove by id (no-op for unknown ids). Never touches the project folder (spec §3a). */
export function removeProject(registry: Registry, id: string): Registry {
  return { projects: registry.projects.filter((p) => p.id !== id) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/registry/registry.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — no errors. (If `existsSync`/`readFileSync` imports in the test are flagged unused, remove the unused ones.)

```bash
git add src/registry/registry.ts src/registry/registry.test.ts
git commit -m "feat(registry): identity-only project registry (load/save/add/remove, slug ids)"
```

---

## Task 2: Extract `buildProjectRoot` into `src/composition/root.ts`

**Files:**
- Create: `src/composition/root.ts`
- Modify: `src/index.ts` (main() body shrinks to CLI parsing + verb dispatch)

This is a **pure mechanical extraction** — behavior must be byte-identical. `src/index.ts:156-486` currently wires everything inside `main()` for one `repoRoot`. Move that wiring into an exported factory so the hub (Task 3) can build one root per project. Like `src/index.ts`, the new file is **untested glue by design** (gotcha `[conductor/wiring]`): every piece it wires is tested; the full suite + typecheck cover the extraction.

- [ ] **Step 1: Create `src/composition/root.ts`**

Move from `src/index.ts` into the new file (cut, don't copy — index.ts re-imports):

- The whole body of `main()` from `const cfg = await loadConfig(repoRoot);` (line ~160) down to `const conductor = createConductor(deps);` (line ~385), **plus** the `buildOrchestrator` function (lines ~443–486) and the module-level helper `splitCommand` (lines ~148–154).
- All imports those lines need (the worker/critic/gate/escalate/anti-drift/etc. import block moves with them; `src/index.ts` keeps only what its remaining code uses).

The new file's public surface:

```ts
/** Everything the daemon knows about ONE project. Built once per project by the
 *  hub (serve) or once for cwd (CLI verbs). Untested glue by design — every
 *  wired piece is unit-tested; typecheck + the full suite cover this file
 *  (gotcha [conductor/wiring], same status as src/index.ts). */
export interface ProjectRoot {
  repoRoot: string;
  cfg: HarnessConfig;
  repo: FileBlackboardRepository;
  conductor: Conductor;
  orchestrator: { handleIntent(intent: string): Promise<OrchestratorResult> };
  log: Logger;
  /** Absolute `<repoRoot>/<stateDir>` — what the API server needs. */
  stateDirAbs: string;
}

export async function buildProjectRoot(repoRoot: string): Promise<ProjectRoot> {
  const cfg = await loadConfig(repoRoot);
  const log = createLogger(join(repoRoot, cfg.stateDir, "conductor.log"));
  // … the moved wiring, verbatim, ending with:
  const conductor = createConductor(deps);
  const orchestrator = buildOrchestrator({ cfg, repoRoot, repo, conductor, log });
  return { repoRoot, cfg, repo, conductor, orchestrator, log, stateDirAbs: join(repoRoot, cfg.stateDir) };
}
```

Notes for the extraction:
- `buildOrchestrator` becomes a private function of `root.ts` (it is only called inside `buildProjectRoot` now — both the old `serve` and `orchestrate` call sites constructed it identically).
- `splitCommand` moves because only the moved wiring uses it.
- Do NOT change any moved logic. No renames beyond what the move forces.

- [ ] **Step 2: Rewire `src/index.ts`**

`main()` becomes:

```ts
async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));

  if (command.mode === "serve") {
    // Multi-project serve is wired in a LATER task (hub + registry). For THIS
    // task keep serve single-project so the extraction lands green:
    const repoRoot = detectRepoRoot(process.cwd());
    const root = await buildProjectRoot(repoRoot);
    const uiDirCandidate = join(repoRoot, "dist", "ui");
    const uiDir = existsSync(uiDirCandidate) ? uiDirCandidate : undefined;
    const handle = createApiServer({
      repo: root.repo,
      stateDir: root.stateDirAbs,
      ...(uiDir !== undefined ? { uiDir } : {}),
      log: root.log,
      onOrchestrate: (intent: string) => root.orchestrator.handleIntent(intent),
    });
    const boundPort = await handle.listen(command.port, "127.0.0.1");
    root.log("INFO", `serve: listening at http://127.0.0.1:${boundPort} (orchestrate endpoint enabled)${uiDir ? "" : ` (API only -- no UI bundle found at ${uiDirCandidate})`}`);
    return;
  }

  const repoRoot = detectRepoRoot(process.cwd());
  const root = await buildProjectRoot(repoRoot);

  if (command.mode === "orchestrate") {
    const result = await root.orchestrator.handleIntent(command.intent);
    root.log("INFO", `orchestrate: ${result.enqueued.length} task(s) enqueued; triggered=${result.triggered}`);
    for (const t of result.enqueued) root.log("INFO", `  - ${t.id} -> ${t.path}`);
    return;
  }
  await root.conductor.run(command.runOpts);
}
```

Keep `parseCli`, `parseArgs`, `parseServeArgs`, and the `main().catch` epilogue in `src/index.ts`.

- [ ] **Step 3: Typecheck + full suite (the extraction's only safety net)**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: ALL green — same totals as before this task (502+).

- [ ] **Step 4: Commit**

```bash
git add src/composition/root.ts src/index.ts
git commit -m "refactor(composition): extract buildProjectRoot from index.ts (mechanical, per-project reuse)"
```

---

## Task 3: ProjectHub — lazy per-project roots with error isolation

**Files:**
- Create: `src/hub/hub.ts`
- Test: `src/hub/hub.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/hub/hub.test.ts` (fake `buildRoot` — no real projects needed):

```ts
import { describe, it, expect } from "vitest";
import { createProjectHub } from "./hub.js";
import type { RegistryEntry } from "../registry/registry.js";

const entries: RegistryEntry[] = [
  { id: "a", name: "A", path: "/proj/a" },
  { id: "b", name: "B", path: "/proj/b" },
];

function makeHub(buildRoot: (e: RegistryEntry) => Promise<unknown>) {
  return createProjectHub({
    loadEntries: async () => entries,
    // The hub is generic over the root type; tests use a plain marker object.
    buildRoot: buildRoot as never,
  });
}

describe("createProjectHub", () => {
  it("get() builds lazily and caches: one build per project across calls", async () => {
    let builds = 0;
    const hub = makeHub(async (e) => {
      builds++;
      return { marker: e.id };
    });
    const r1 = await hub.get("a");
    const r2 = await hub.get("a");
    expect(r1).toEqual({ root: { marker: "a" } });
    expect(r2).toEqual({ root: { marker: "a" } });
    expect(builds).toBe(1);
  });

  it("get() on an unknown id -> null (never builds)", async () => {
    let builds = 0;
    const hub = makeHub(async () => {
      builds++;
      return {};
    });
    expect(await hub.get("zz")).toBeNull();
    expect(builds).toBe(0);
  });

  it("a failing build isolates to that project and is retried on the next get()", async () => {
    let attempts = 0;
    const hub = makeHub(async (e) => {
      if (e.id === "a") {
        attempts++;
        if (attempts === 1) throw new Error("bad config.yaml");
        return { marker: "a-fixed" };
      }
      return { marker: e.id };
    });
    const fail = await hub.get("a");
    expect(fail).toEqual({ error: expect.stringContaining("bad config.yaml") as string });
    // Sibling project unaffected:
    expect(await hub.get("b")).toEqual({ root: { marker: "b" } });
    // Retry after the config is fixed:
    expect(await hub.get("a")).toEqual({ root: { marker: "a-fixed" } });
  });

  it("concurrent get() for the same id builds once (in-flight promise is shared)", async () => {
    let builds = 0;
    const hub = makeHub(async (e) => {
      builds++;
      await new Promise((r) => setTimeout(r, 10));
      return { marker: e.id };
    });
    const [r1, r2] = await Promise.all([hub.get("a"), hub.get("a")]);
    expect(r1).toEqual(r2);
    expect(builds).toBe(1);
  });

  it("list() returns entries + build status without forcing builds", async () => {
    let builds = 0;
    const hub = makeHub(async (e) => {
      builds++;
      return { marker: e.id };
    });
    expect(await hub.list()).toEqual([
      { id: "a", name: "A", path: "/proj/a", status: "unbuilt" },
      { id: "b", name: "B", path: "/proj/b", status: "unbuilt" },
    ]);
    expect(builds).toBe(0);
    await hub.get("a");
    expect(await hub.list()).toEqual([
      { id: "a", name: "A", path: "/proj/a", status: "ready" },
      { id: "b", name: "B", path: "/proj/b", status: "unbuilt" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hub/hub.test.ts`
Expected: FAIL — `./hub.js` does not exist.

- [ ] **Step 3: Implement `src/hub/hub.ts`**

```ts
import type { RegistryEntry } from "../registry/registry.js";

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  /** "unbuilt" = never requested; "ready" = root built; "error" = last build failed. */
  status: "unbuilt" | "ready" | "error";
  /** Present only when status === "error". */
  error?: string;
}

export type HubGetResult<R> = { root: R } | { error: string } | null;

export interface ProjectHub<R> {
  /** Registry entries + build status. NEVER forces a build (the sidebar must
   *  render instantly even when a project's config is broken — spec §3b/§6). */
  list(): Promise<ProjectSummary[]>;
  /** Lazily build (and cache) the project's composition root. Unknown id -> null.
   *  Build failure -> {error} — NOT cached, so fixing config.yaml + retrying works. */
  get(id: string): Promise<HubGetResult<R>>;
}

/**
 * One composition root per registered project, built on first use. A failing
 * build (bad config.yaml, missing path) is isolated to that project: it
 * reports an error state and never poisons siblings or crashes serve (spec §6).
 */
export function createProjectHub<R>(deps: {
  loadEntries: () => Promise<RegistryEntry[]>;
  buildRoot: (entry: RegistryEntry) => Promise<R>;
  log?: (level: string, message: string) => void;
}): ProjectHub<R> {
  const roots = new Map<string, Promise<R>>();
  const lastError = new Map<string, string>();

  return {
    async list(): Promise<ProjectSummary[]> {
      const entries = await deps.loadEntries();
      return entries.map((e) => {
        const err = lastError.get(e.id);
        if (roots.has(e.id)) return { id: e.id, name: e.name, path: e.path, status: "ready" };
        if (err !== undefined) return { id: e.id, name: e.name, path: e.path, status: "error", error: err };
        return { id: e.id, name: e.name, path: e.path, status: "unbuilt" };
      });
    },

    async get(id: string): Promise<HubGetResult<R>> {
      const entries = await deps.loadEntries();
      const entry = entries.find((e) => e.id === id);
      if (!entry) return null;

      const cached = roots.get(id);
      if (cached) {
        return { root: await cached };
      }

      const building = deps.buildRoot(entry);
      roots.set(id, building); // set BEFORE await: concurrent get()s share the in-flight build
      try {
        const root = await building;
        lastError.delete(id);
        return { root };
      } catch (err) {
        roots.delete(id); // not cached -> a later get() retries after the operator fixes the config
        const message = err instanceof Error ? err.message : String(err);
        lastError.set(id, message);
        deps.log?.("ERROR", `hub: failed to build project '${id}' (${entry.path}): ${message}`);
        return { error: message };
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hub/hub.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — no errors.

```bash
git add src/hub/hub.ts src/hub/hub.test.ts
git commit -m "feat(hub): lazy per-project composition roots with error isolation"
```

---

## Task 4: API server — `projects` port + route re-rooting (the big mechanical one)

**Files:**
- Modify: `src/api/server.ts`
- Modify: `src/api/server.test.ts`

Old top-level routes are REMOVED in this same task (spec §3c — the bundled UI is the only consumer; Task 10 updates it).

- [ ] **Step 1: Reshape `ApiServerDeps` and add the test helper**

In `src/api/server.ts`, replace the `repo`/`stateDir`/`onOrchestrate` fields of `ApiServerDeps` (lines ~136–163) with a `projects` port (keep `uiDir`, `watchFactory`, `now`, `log` as-is):

```ts
/** Per-project view the server needs — a narrow slice of the hub's ProjectRoot. */
export interface ProjectView {
  repo: BlackboardRepository;
  /** Absolute `<repoRoot>/<stateDir>` for this project. */
  stateDir: string;
  /** Optional orchestrate launcher for THIS project (R1-thin callback, unchanged semantics). */
  onOrchestrate?: (intent: string) => Promise<unknown>;
}

export interface ApiServerDeps {
  projects: {
    /** Sidebar list: registry + build status. Must never throw (an empty daemon lists []). */
    list(): Promise<Array<{ id: string; name: string; path: string; status: string; error?: string }>>;
    /** Resolve one project. null = unknown id; {error} = registered but failed to build. */
    get(id: string): Promise<{ view: ProjectView } | { error: string } | null>;
  };
  uiDir?: string;
  watchFactory?: (stateDir: string, onChange: (path: string) => void) => { close(): Promise<void> | void };
  now?: () => number;
  log?: (level: string, message: string) => void;
}
```

In `src/api/server.test.ts`, add near the top (after imports) the compatibility helper, and a URL helper:

```ts
/** Wrap a single {repo, stateDir[, onOrchestrate]} as a one-project deps object
 *  (project id "p1") — keeps the existing single-project test bodies unchanged
 *  except for the URL prefix. */
function projectDeps(
  one: { repo: BlackboardRepository; stateDir: string; onOrchestrate?: (intent: string) => Promise<unknown> },
  extra: Partial<ApiServerDeps> = {},
): ApiServerDeps {
  return {
    projects: {
      list: async () => [{ id: "p1", name: "p1", path: one.stateDir, status: "ready" }],
      get: async (id) =>
        id === "p1"
          ? {
              view: {
                repo: one.repo,
                stateDir: one.stateDir,
                ...(one.onOrchestrate !== undefined ? { onOrchestrate: one.onOrchestrate } : {}),
              },
            }
          : null,
    },
    ...extra,
  };
}

/** Prefix an API path with the default test project. */
const p1 = (path: string): string => `/projects/p1${path}`;
```

- [ ] **Step 2: Mechanically migrate every existing construction + URL**

Two systematic passes over `src/api/server.test.ts` (~50 sites each):

1. `createApiServer({ repo, stateDir` → `createApiServer(projectDeps({ repo, stateDir`, closing the extra paren: options that belong to the server (`watchFactory`, `now`, `uiDir`) go into the helper's second arg. Examples:
   - `createApiServer({ repo, stateDir })` → `createApiServer(projectDeps({ repo, stateDir }))`
   - `createApiServer({ repo, stateDir, now: () => 424242 })` → `createApiServer(projectDeps({ repo, stateDir }, { now: () => 424242 }))`
   - `createApiServer({ repo, stateDir, watchFactory: fakeWatchFactory })` → `createApiServer(projectDeps({ repo, stateDir }, { watchFactory: fakeWatchFactory }))`
   - `createApiServer({ repo, stateDir, onOrchestrate })` → `createApiServer(projectDeps({ repo, stateDir, onOrchestrate }))`
   - `uiDir` sites: `createApiServer({ repo, stateDir, uiDir })` → `createApiServer(projectDeps({ repo, stateDir }, { uiDir }))`
2. Every request URL for an API route gains the prefix: `` `${base}/state` `` → `` `${base}${p1("/state")}` `` — same for `/runs`, `/runs/:id`, `/tasks/...`, `/escalations/...`, `/orchestrate`. **Static-serving URLs (`/`, `/index.html`, `/assets/...`) stay top-level** — the UI bundle is daemon-global, not per-project.

- [ ] **Step 3: Write the new failing routing tests**

Add a new describe block:

```ts
describe("createApiServer / multi-project routing", () => {
  it("GET /projects returns the project list", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Array<{ id: string }> };
    expect(body.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("unknown project id -> 404 for every project-scoped route", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    for (const path of ["/projects/zz/state", "/projects/zz/runs", "/projects/zz/escalations/e1"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("a project in error state -> 503 with the error body, siblings unaffected", async () => {
    const deps: ApiServerDeps = {
      projects: {
        list: async () => [
          { id: "ok", name: "ok", path: "/x", status: "ready" },
          { id: "bad", name: "bad", path: "/y", status: "error", error: "bad config.yaml" },
        ],
        get: async (id) =>
          id === "ok" ? { view: { repo, stateDir } } : id === "bad" ? { error: "bad config.yaml" } : null,
      },
    };
    handle = createApiServer(deps);
    const port = await handle.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/projects/bad/state`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${port}/projects/ok/state`)).status).toBe(200);
  });

  it("two projects serve their OWN state (no cross-bleed)", async () => {
    const dirB = mkdtempSync(join(tmpdir(), "adh-api-b-"));
    try {
      const repoB = new FileBlackboardRepository(dirB, ".autodev");
      await seedTask(repoB, "pending", "t-b1"); // reuse the file's existing task-seeding helper; if it is inline in tests, inline the same 3 lines here
      const deps: ApiServerDeps = {
        projects: {
          list: async () => [
            { id: "a", name: "a", path: stateDir, status: "ready" },
            { id: "b", name: "b", path: dirB, status: "ready" },
          ],
          get: async (id) =>
            id === "a"
              ? { view: { repo, stateDir } }
              : id === "b"
                ? { view: { repo: repoB, stateDir: join(dirB, ".autodev") } }
                : null,
        },
      };
      handle = createApiServer(deps);
      const port = await handle.listen(0);
      const a = (await (await fetch(`http://127.0.0.1:${port}/projects/a/state`)).json()) as { queues: { pending: unknown[] } };
      const b = (await (await fetch(`http://127.0.0.1:${port}/projects/b/state`)).json()) as { queues: { pending: Array<{ id: string }> } };
      expect(b.queues.pending.map((t) => t.id)).toContain("t-b1");
      expect(a.queues.pending.map((t: { id: string }) => t.id)).not.toContain("t-b1");
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("old top-level routes are GONE (404)", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    for (const path of ["/state", "/runs", "/orchestrate"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});
```

(Adapt the task-seeding line to however this test file already seeds pending tasks — copy the exact existing pattern; do not invent a new helper if one exists.)

- [ ] **Step 4: Run to verify the new tests fail**

Run: `npx vitest run src/api/server.test.ts -t "multi-project routing"`
Expected: FAIL — routes don't exist yet (and the file may not compile until Step 5; that counts as failing).

- [ ] **Step 5: Re-root the server implementation**

In `src/api/server.ts`:

1. Every project-scoped handler gains a leading `p: ProjectView` parameter and uses it instead of `deps`:
   - `handleState(res)` → `handleState(p: ProjectView, res)`; `deps.repo` → `p.repo`, `deps.stateDir` → `p.stateDir` (digest path).
   - Same for `handleListRuns`, `handleGetRun`, `handleReadRuntimeFile`, `handleListRuntimeFiles`, `handleGetEscalation`, `handleReply`, `handleOrchestrate` (which uses `p.onOrchestrate`; keep its absent-`onOrchestrate` → 404 behavior per project).
2. Rewrite the dispatch in `handleRequest` (lines ~973–1062). Insert BEFORE the static-serving fallback:

```ts
    if (req.method === "GET" && (url.pathname === "/projects" || url.pathname === "/projects/")) {
      sendJson(res, 200, { projects: await deps.projects.list() });
      return;
    }

    const projMatch = /^\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (projMatch) {
      const rawPid = decodeSegment(projMatch[1]!);
      if (rawPid === null || !safeIdSegment(rawPid)) {
        sendJson(res, 400, { error: "invalid project id" });
        return;
      }
      const resolved = await deps.projects.get(rawPid);
      if (resolved === null) {
        sendJson(res, 404, { error: "project not found" });
        return;
      }
      if ("error" in resolved) {
        sendJson(res, 503, { error: `project failed to load: ${resolved.error}` });
        return;
      }
      const p = resolved.view;
      const sub = projMatch[2] ?? "/";

      if (req.method === "GET" && (sub === "/state" || sub === "/state/")) return void (await handleState(p, res));
      if (req.method === "GET" && (sub === "/runs" || sub === "/runs/")) return void (await handleListRuns(p, res));
      const runMatch = /^\/runs\/([^/]+)\/?$/.exec(sub);
      if (req.method === "GET" && runMatch) return void (await handleGetRun(p, runMatch[1]!, res));
      const runtimeFileMatch = /^\/tasks\/([^/]+)\/runtime\/([^/]+)\/?$/.exec(sub);
      if (req.method === "GET" && runtimeFileMatch)
        return void (await handleReadRuntimeFile(p, runtimeFileMatch[1]!, runtimeFileMatch[2]!, res));
      const runtimeListMatch = /^\/tasks\/([^/]+)\/runtime\/?$/.exec(sub);
      if (req.method === "GET" && runtimeListMatch) return void (await handleListRuntimeFiles(p, runtimeListMatch[1]!, res));
      const escGetMatch = /^\/escalations\/([^/]+)\/?$/.exec(sub);
      if (req.method === "GET" && escGetMatch) return void (await handleGetEscalation(p, escGetMatch[1]!, res));
      const replyMatch = /^\/escalations\/([^/]+)\/reply\/?$/.exec(sub);
      if (req.method === "POST" && replyMatch) return void (await handleReply(p, replyMatch[1]!, req, res));
      if (req.method === "POST" && (sub === "/orchestrate" || sub === "/orchestrate/"))
        return void (await handleOrchestrate(rawPid, p, req, res));

      sendJson(res, 404, { error: "not found" });
      return;
    }
```

   and DELETE the old top-level `/state`, `/runs`, `/runs/:id`, `/tasks/...`, `/escalations/...`, `/orchestrate` matches. The static-UI fallback block stays exactly as-is (top-level, daemon-global).
3. Single-flight becomes per-project: replace `let orchestrateInFlight = false;` with `const orchestrateInFlight = new Set<string>();`, and in `handleOrchestrate(pid: string, p: ProjectView, …)` replace the boolean check/set/clear with `orchestrateInFlight.has(pid)` / `.add(pid)` / `.delete(pid)` (same synchronous-before-202 placement, same `finally` clearing — the existing comments explain why; keep them, updating "one may run at a time" to "one per project").

- [ ] **Step 6: Run the full server suite**

Run: `npx vitest run src/api/server.test.ts`
Expected: PASS — all migrated tests + the new multi-project block. Iterate on missed mechanical sites until green.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck` — expect errors OUTSIDE the api module only in `src/index.ts` (its serve block still builds the old deps shape). Fix `src/index.ts` serve block minimally to compile against the new deps (single-project wrap, same as the test helper):

```ts
    const handle = createApiServer({
      projects: {
        list: async () => [{ id: "local", name: "local", path: repoRoot, status: "ready" }],
        get: async (id) =>
          id === "local"
            ? { view: { repo: root.repo, stateDir: root.stateDirAbs, onOrchestrate: (i: string) => root.orchestrator.handleIntent(i) } }
            : null,
      },
      ...(uiDir !== undefined ? { uiDir } : {}),
      log: root.log,
    });
```

(This interim wrap is replaced by the real registry+hub wiring in Task 7.)

Run: `npm run typecheck` again — no errors. Then the FULL suite:

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: all green.

```bash
git add src/api/server.ts src/api/server.test.ts src/index.ts
git commit -m "feat(api): re-root all routes under /projects/:id + projects port (multi-project)"
```

---

## Task 5: WS — per-project watchers + projectId in change events

**Files:**
- Modify: `src/api/server.ts`
- Test: `src/api/server.test.ts` (the existing "WS change stream" describe block)

- [ ] **Step 1: Write the failing test**

The existing WS test uses `fakeWatchFactory` (see the file's current WS block — it captures the `onChange` callback and fires it manually). Extend that block:

```ts
it("change events carry the projectId of the project whose stateDir changed", async () => {
  // fakeWatchFactory captures one onChange per watched stateDir, keyed by dir:
  const onChangeByDir = new Map<string, (path: string) => void>();
  const factory = (dir: string, onChange: (path: string) => void) => {
    onChangeByDir.set(dir, onChange);
    return { close: () => {} };
  };
  handle = createApiServer(projectDeps({ repo, stateDir }, { watchFactory: factory }));
  const port = await handle.listen(0);

  // A project's watcher is attached on first resolution — touch the project once:
  await fetch(`http://127.0.0.1:${port}${p1("/state")}`);
  expect(onChangeByDir.has(stateDir)).toBe(true);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.on("open", () => resolve()));
  const msg = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
  onChangeByDir.get(stateDir)!("queue/pending/t1.md");
  const parsed = JSON.parse(await msg) as { type: string; projectId: string; path: string };
  expect(parsed).toEqual({ type: "change", projectId: "p1", path: "queue/pending/t1.md" });
  ws.close();
});
```

(Match the file's existing WS-client idiom — it already opens `ws://` connections; reuse the same import/pattern.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/api/server.test.ts -t "carry the projectId"`
Expected: FAIL — the current code creates ONE watcher for a `deps.stateDir` that no longer exists on the deps type (this line is a leftover compile error from Task 4 if not already handled; either way the event has no `projectId`).

- [ ] **Step 3: Implement per-project watchers**

In `createApiServer`:

1. Delete the single `const watcher = watchFactory(deps.stateDir, broadcastChange);`.
2. Add a watcher registry + per-project attach:

```ts
  // One fs-watcher per BUILT project, attached the first time the project
  // resolves (the sidebar's per-project fetches touch every listed project, so
  // all browsable projects get live events). Keyed by project id.
  const watchers = new Map<string, { close(): Promise<void> | void }>();

  function ensureWatcher(projectId: string, projectStateDir: string): void {
    if (watchers.has(projectId)) return;
    watchers.set(
      projectId,
      watchFactory(projectStateDir, (changedPath) => broadcastChange(projectId, changedPath)),
    );
  }
```

3. `broadcastChange` gains the id: `function broadcastChange(projectId: string, changedPath: string): void` with `const message = JSON.stringify({ type: "change", projectId, path: changedPath });`.
4. In the `handleRequest` project-resolution block (Task 4 Step 5), after `const p = resolved.view;` add: `ensureWatcher(rawPid, p.stateDir);`.
5. In `close()`, replace `await watcher.close();` with:

```ts
      for (const w of watchers.values()) await w.close();
      watchers.clear();
```

- [ ] **Step 4: Run the WS block + full server suite**

Run: `npx vitest run src/api/server.test.ts`
Expected: PASS. If an older WS test asserted the exact message shape `{type,path}`, update it to include `projectId: "p1"` (it is part of this task's contract change).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — no errors.

```bash
git add src/api/server.ts src/api/server.test.ts
git commit -m "feat(api): per-project fs watchers; WS change events carry projectId"
```

---

## Task 6: Per-project orchestrate single-flight (concurrency proof)

**Files:**
- Test: `src/api/server.test.ts` (behavior implemented in Task 4 Step 5.3 — this task pins it)

- [ ] **Step 1: Write the tests**

Add to the existing orchestrate describe block (reuse its deferred-promise idiom for a hanging `onOrchestrate` — the block already tests the 409 single-flight with one):

```ts
it("single-flight is PER PROJECT: project B can orchestrate while A is in flight", async () => {
  let releaseA!: () => void;
  const hangingA = new Promise<void>((r) => (releaseA = r));
  const calls: string[] = [];
  const deps: ApiServerDeps = {
    projects: {
      list: async () => [
        { id: "a", name: "a", path: "/a", status: "ready" },
        { id: "b", name: "b", path: "/b", status: "ready" },
      ],
      get: async (id) =>
        id === "a"
          ? { view: { repo, stateDir, onOrchestrate: async (i) => { calls.push(`a:${i}`); await hangingA; } } }
          : id === "b"
            ? { view: { repo, stateDir, onOrchestrate: async (i) => { calls.push(`b:${i}`); } } }
            : null,
    },
  };
  handle = createApiServer(deps);
  const port = await handle.listen(0);
  const post = (pid: string) =>
    fetch(`http://127.0.0.1:${port}/projects/${pid}/orchestrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "do the thing" }),
    });

  expect((await post("a")).status).toBe(202); // A starts and hangs
  expect((await post("a")).status).toBe(409); // A again -> busy
  expect((await post("b")).status).toBe(202); // B is NOT blocked by A
  releaseA();
});
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run src/api/server.test.ts -t "PER PROJECT"`
Expected: PASS if Task 4's Set-keyed single-flight is correct; if the B request returns 409, the flag is still global — fix `handleOrchestrate` to key on `pid`.

- [ ] **Step 3: Commit**

```bash
git add src/api/server.test.ts
git commit -m "test(api): per-project orchestrate single-flight (concurrent projects allowed)"
```

---

## Task 7: `serve` wiring — registry + hub + module-relative uiDir

**Files:**
- Modify: `src/index.ts` (the serve block only; untested glue — gotcha `[conductor/wiring]`)

- [ ] **Step 1: Rewrite the serve block**

Replace the interim single-project wrap (Task 4 Step 7) with the real wiring:

```ts
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadRegistry } from "./registry/registry.js";
import { createProjectHub } from "./hub/hub.js";
import { buildProjectRoot, type ProjectRoot } from "./composition/root.js";
```

```ts
  if (command.mode === "serve") {
    // serve is DAEMON-GLOBAL: no cwd binding, no detectRepoRoot (spec §3b).
    const log = createLogger(join(homedir(), ".autodev", "daemon.log"));
    const registryFile = process.env["AUTODEV_REGISTRY"] ?? join(homedir(), ".autodev", "projects.json");

    const hub = createProjectHub<ProjectRoot>({
      loadEntries: async () => (await loadRegistry(registryFile, log)).projects,
      buildRoot: (entry) => buildProjectRoot(entry.path),
      log,
    });

    // UI bundle lives with the INSTALL, not any project (closes [ui/serve-uidir-reporoot]):
    // compiled layout is dist/index.js + dist/ui. AUTODEV_UI_DIR overrides (dev runs vite anyway).
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const uiDirCandidate = process.env["AUTODEV_UI_DIR"] ?? join(moduleDir, "ui");
    const uiDir = existsSync(uiDirCandidate) ? uiDirCandidate : undefined;

    const handle = createApiServer({
      projects: {
        list: () => hub.list(),
        get: async (id) => {
          const r = await hub.get(id);
          if (r === null || "error" in r) return r;
          const root = r.root;
          return {
            view: {
              repo: root.repo,
              stateDir: root.stateDirAbs,
              onOrchestrate: (intent: string) => root.orchestrator.handleIntent(intent),
            },
          };
        },
      },
      ...(uiDir !== undefined ? { uiDir } : {}),
      log,
    });
    const boundPort = await handle.listen(command.port, "127.0.0.1");
    log("INFO", `serve: listening at http://127.0.0.1:${boundPort} — registry ${registryFile}${uiDir ? "" : ` (API only -- no UI bundle at ${uiDirCandidate})`}`);
    return;
  }
```

Note: `createLogger` here writes to `~/.autodev/daemon.log` (daemon-global). Check `createLogger`'s contract in `src/util/log.ts` first — if it requires the parent dir, `mkdir` it (`mkdirSync(join(homedir(), ".autodev"), { recursive: true })`) before creating the logger, matching however `buildProjectRoot` handles it today.

- [ ] **Step 2: Typecheck + full suite + manual smoke**

Run: `npm run typecheck` — no errors.
Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true` — all green.

Manual smoke (registry + serve, PowerShell):

```powershell
$env:AUTODEV_REGISTRY = "$env:TEMP\adh-smoke\projects.json"
New-Item -ItemType Directory -Force "$env:TEMP\adh-smoke" | Out-Null
'{ "projects": [ { "id": "harness", "name": "harness", "path": "D:/Projects/autodev-harness" } ] }' |
  Set-Content "$env:TEMP\adh-smoke\projects.json"
npm run build; node dist/index.js serve --port 4177
# other terminal:
#   curl http://127.0.0.1:4177/projects            -> {"projects":[{"id":"harness",...}]}
#   curl http://127.0.0.1:4177/projects/harness/state -> queues JSON
#   curl http://127.0.0.1:4177/projects/zz/state      -> 404
```

Expected: the three curl results as annotated; `dist/ui` (built by `npm run build:ui` earlier or absent) serves or logs "API only" — both fine.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(serve): daemon-global multi-project serve (registry + hub + install-relative uiDir)"
```

---

## Task 8: Code-complete sweep

- [ ] **Step 1: Full suite + typecheck, one last time**

Run: `npm run typecheck` && `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: green; total test count strictly above the pre-plan 502.

- [ ] **Step 2: Grep for leftovers**

Run: `grep -rn "deps.repo\|deps.stateDir\|orchestrateInFlight = false\|detectRepoRoot" src/api/ src/index.ts`
Expected: NO hits for the first three; `detectRepoRoot` appears ONLY in the CLI (`run`/`orchestrate`) path of `src/index.ts`, never in serve.

- [ ] **Step 3: Commit any stragglers**

```bash
git status --short   # should be clean; commit anything intentional that remains
```

---

## Task 9 — CODE-COMPLETE GATE (not a code edit)

- [ ] **Independent codex GPT-5.5 review of the whole M1–M2 diff** (Windows, inline diff — gotcha `[critic/codex]`). Build `prompt + git diff main...HEAD -- src/` to a file, then:

```bash
cat <promptfile> | codex exec -m gpt-5.5 -c model_reasoning_effort="high" -c approval_policy="never" -s read-only -C D:/Projects/autodev-harness --skip-git-repo-check -
```

Focus the critic on: (a) **R1 preservation** — the per-project `onOrchestrate` closure still exposes exactly `handleIntent`, nothing more; no gate/worker/commit handle reaches the server; (b) project-id handling — can a crafted `:id` (encoded separators, `..`) reach the fs through registry paths or route params (`safeIdSegment` on `rawPid`); (c) single-flight correctness under races (Set add before 202, delete in finally); (d) watcher lifecycle (leak on close? double-attach? watcher for a project whose root later errors); (e) hub caching (error retry can't stampede; concurrent get shares one build); (f) the extraction — any accidental behavior change vs the pre-plan `main()`.

- [ ] **Fix every finding with a regression test; re-critic each fix.** Never self-certify.

---

## Task 10 — UI shim: keep the s14 dashboard working until M4 (review-only, no gate)

**Files:**
- Modify: `ui/src/lib/` (wherever the fetch base + WS handler live — locate with `grep -rn "\"/state\"\|/runs\|new WebSocket" ui/src/`)

The M4 shell rebuilds the UI properly; this task only keeps every merge shippable (working software per merge).

- [ ] **Step 1: Add a default-project resolver**

On app boot, `GET /projects`, take the FIRST project's id (empty list → render a plain "no projects registered — edit ~/.autodev/projects.json" note), store it in the existing zustand store, and prefix every API call with `/projects/${id}`. WS handler: ignore change events whose `projectId` differs from the selected one.

- [ ] **Step 2: Verify against a live serve**

Run the Task 7 smoke `serve` + `npm run dev:ui`; open the dashboard: Home/Board/Run/Task screens all load for the first registered project; WS-live updates still arrive (touch a queue file, watch the board refresh).

- [ ] **Step 3: Commit**

```bash
git add ui/src
git commit -m "feat(ui): default-project shim over /projects routes (interim until M4 shell)"
```

---

## Self-Review

**Spec coverage (M1–M2 scope):** §3a registry identity-only + slug ids + corrupt-file behavior → Task 1; §3b lazy per-project roots, error isolation, per-project single-flight → Tasks 2, 3, 4.5.3, 6; §3c route table (GET /projects, per-project routes, WS projectId, old routes removed) → Tasks 4, 5 (POST/DELETE /projects and /fs/dirs are M3 — deliberately absent); §3d bundle-from-install → Task 7; §6 error handling (registry never crashes serve, per-project 503 isolation) → Tasks 1, 3, 4; §7 testing points 1–4 → Tasks 1, 3, 4, 5, 6, 7 (point 5–6 are M3); §8 discipline → Tasks 9 (gate) + 10 (review-only UI). Working-software-per-merge → Task 10 shim.

**Placeholder scan:** no TBDs; every code step carries code. Two deliberate delegations to in-file reality (NOT placeholders — the target content already exists and must be copied, not invented): Task 4 Step 3's task-seeding line says "copy the file's existing seeding pattern"; Task 5 Step 1 says "reuse the file's existing WS-client idiom". Task 2 is an extraction whose content is `src/index.ts`'s own lines — reproducing 230 lines here verbatim would only invite drift.

**Type consistency:** `RegistryEntry{id,name,path}` (T1) = hub's `loadEntries` element (T3) = serve wiring (T7). `ProjectView{repo,stateDir,onOrchestrate?}` (T4) = test helper (T4) = hub→view adapter (T7). `ProjectSummary.status` `"unbuilt"|"ready"|"error"` (T3) = `projects.list()` payload (T4 tests assert only `id`, safe). `buildProjectRoot(repoRoot)` (T2) called as `buildProjectRoot(entry.path)` (T7) ✓. WS shape `{type:"change",projectId,path}` (T5) = UI shim filter (T10).

## Related

- `docs/superpowers/specs/2026-07-03-p3-multiproject-shell-design.md` — the approved design (M1–M2 = §3).
- M3 (fs-browser + register + scaffold), M4 (shell UI), M5 (themes) get their own plans when picked up.
- Gotchas in play: `[conductor/wiring]`, `[ts/typecheck-scope]`, `[ts/zod]` (exactOptionalPropertyTypes), `[critic/codex]`, `[ui/serve-uidir-reporoot]` (closed by Task 7).
