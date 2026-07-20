# Overnight Presence Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the s45 overnight escalation supervisor reachable — a global operator-presence switch in the sidebar that, ANDed with a per-project opt-in, decides whether a daemon run supervises escalations unattended or behaves exactly as today.

**Architecture:** A new `src/settings/` module owns a daemon-global `~/.autodev/settings.json`. `runOrSupervise` gains a read-through `presence()` port (fresh file read per call, failure → `false`), and its condition becomes `presence() && cfg.autonomy.overnight.enabled`. The orchestrator's `trigger` — the daemon's only run entry point — is rerouted through `runOrSupervise`. Two new global HTTP routes (`GET`/`PATCH /settings`) expose the flag plus honest opt-in counts, and a shadcn `switch` in the sidebar footer drives them.

**Tech Stack:** Node + TypeScript (ESM, `.js` import specifiers), zod for schemas, vitest for tests, React + TanStack Query + Router, shadcn on Base UI (`base-nova` style), Tailwind.

**Read before starting:** `docs/superpowers/specs/2026-07-19-overnight-presence-toggle-design.md` (the approved spec this plan implements) and `AGENTS.md` (English-only artifacts, shadcn-first, review discipline).

**Conventions that apply to every task:**
- Tests are colocated: `src/foo/bar.ts` → `src/foo/bar.test.ts`.
- Imports of local modules carry the `.js` extension (ESM), e.g. `import { loadSettings } from "./settings.js"`.
- `exactOptionalPropertyTypes` is on: derive types with `z.infer`, never hand-write `x?: T` against a `.optional()` zod field (gotcha `[ts/zod]`).
- Run `npm run typecheck` after any task that touches types — vitest does NOT typecheck.
- All code, comments, and commit messages are in English.
- Commit after every task. Do not open a PR; this branch batches (AGENTS.md "Batch merges").

**Branch:** work on `autodev/s46-overnight-presence-toggle` (already created; the spec commit `8e3a768` is on it).

---

### Task 1: Global settings store

The daemon has no global settings store today — only `~/.autodev/projects.json`. This creates one, modelled on `src/registry/registry.ts` (never-throws load, fail-soft to defaults + a loud log).

**Files:**
- Create: `src/settings/settings.ts`
- Test: `src/settings/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/settings/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "./settings.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autodev-settings-"));
  file = join(dir, "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("returns defaults for a missing file, without logging", async () => {
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs).toEqual([]);
  });

  it("returns defaults + an ERROR log for corrupt JSON", async () => {
    await writeFile(file, "{not json", "utf8");
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });

  it("returns defaults + an ERROR log when the shape violates the schema", async () => {
    await writeFile(file, JSON.stringify({ overnight: { enabled: "yes" } }), "utf8");
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });

  it("rejects an unknown top-level key loudly instead of silently reverting", async () => {
    // .strict() guards the [config/zod-strict] class: a stale/misspelled key must
    // not load clean while every real field silently falls back to a default.
    await writeFile(file, JSON.stringify({ overnite: { enabled: true } }), "utf8");
    const logs: string[] = [];
    expect(await loadSettings(file, (l, m) => logs.push(`${l} ${m}`))).toEqual(DEFAULT_SETTINGS);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });

  it("round-trips a saved value", async () => {
    await saveSettings(file, { overnight: { enabled: true } });
    expect(await loadSettings(file)).toEqual({ overnight: { enabled: true } });
  });
});

describe("saveSettings", () => {
  it("creates parent directories", async () => {
    const nested = join(dir, "deep", "settings.json");
    await saveSettings(nested, { overnight: { enabled: true } });
    expect(JSON.parse(await readFile(nested, "utf8"))).toEqual({ overnight: { enabled: true } });
  });

  it("refuses to write when the target exists but is not a regular file", async () => {
    await mkdir(file); // a directory where settings.json should be
    await expect(saveSettings(file, { overnight: { enabled: true } })).rejects.toThrow(/not a regular file/i);
  });

  it("serializes concurrent writes (last write wins, no interleaving)", async () => {
    await Promise.all([
      saveSettings(file, { overnight: { enabled: true } }),
      saveSettings(file, { overnight: { enabled: false } }),
      saveSettings(file, { overnight: { enabled: true } }),
    ]);
    // Whatever the order, the file must be valid parseable settings, never a torn write.
    expect(await loadSettings(file)).toEqual({ overnight: { enabled: true } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/settings/settings.test.ts`
Expected: FAIL — `Failed to resolve import "./settings.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/settings/settings.ts`:

```ts
/**
 * Daemon-global settings (spec 2026-07-19). Operator PRESENCE lives here, not in
 * any project's config: presence is a property of the operator (ADR-004 tenet 5),
 * while `autonomy.overnight.enabled` in a project's `.autodev/config.yaml` stays
 * the per-project opt-in. Overnight autonomy runs on the AND of the two.
 *
 * Sibling of `~/.autodev/projects.json`; same never-throws discipline as
 * `registry.ts` -- a daemon must not die over a bad settings file, and every
 * ambiguity resolves toward PRESENCE (attended), i.e. toward LESS unattended spend.
 */
import { readFile, writeFile, mkdir, rename, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

type Log = (level: string, message: string) => void;

/** `.strict()` at every level: an unknown/misspelled key must fail LOUDLY rather
 *  than load clean while silently reverting every real field to a default
 *  (gotcha [config/zod-strict]). An object (not a bare boolean) leaves room for a
 *  later `until` field as an ADDITIVE change. */
export const GlobalSettingsSchema = z
  .object({
    overnight: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .default({ enabled: false }),
  })
  .strict();

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export const DEFAULT_SETTINGS: GlobalSettings = { overnight: { enabled: false } };

/** Default location, mirroring the registry's `AUTODEV_REGISTRY` escape hatch
 *  (`src/index.ts`) so tests can point at a temp dir. */
export function defaultSettingsFile(homeDir: string): string {
  return process.env["AUTODEV_SETTINGS"] ?? join(homeDir, ".autodev", "settings.json");
}

/**
 * Load global settings. NEVER throws. A missing file is the normal first-run case
 * -> silent defaults. Anything else (unreadable, corrupt JSON, schema violation)
 * -> defaults + one ERROR log, so the daemon keeps serving and the operator can
 * see why the toggle reads off.
 */
export async function loadSettings(file: string, log?: Log): Promise<GlobalSettings> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.("ERROR", `settings: failed reading ${file}: ${String(err)} — using defaults`);
    }
    return DEFAULT_SETTINGS;
  }
  try {
    return GlobalSettingsSchema.parse(JSON.parse(text));
  } catch (err) {
    log?.("ERROR", `settings: invalid ${file} — using defaults (${String(err)})`);
    return DEFAULT_SETTINGS;
  }
}

/** Serializes writes so two concurrent PATCHes cannot interleave. One daemon,
 *  one tiny file -- a promise chain is the same primitive `ProjectAdmin` uses. */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Write settings atomically (tmp + rename). Refuses when the target exists and is
 * not a regular file -- a symlinked/directory `settings.json` would otherwise be
 * followed transparently ([scaffold/config-file-symlink]: a dir-level guard does
 * not transfer to a single-file write shape).
 */
export async function saveSettings(file: string, settings: GlobalSettings): Promise<void> {
  const run = async (): Promise<void> => {
    const stats = await lstat(file).catch(() => null);
    if (stats !== null && !stats.isFile()) {
      throw new Error(`settings: ${file} exists but is not a regular file — refusing to write`);
    }
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(GlobalSettingsSchema.parse(settings), null, 2) + "\n", "utf8");
    await rename(tmp, file);
  };
  const next = writeChain.then(run, run);
  // Keep the chain alive after a rejection so one failed write can't wedge later ones.
  writeChain = next.catch(() => undefined);
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/settings/settings.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add src/settings/settings.ts src/settings/settings.test.ts
git commit -m "feat(settings): daemon-global settings store for operator presence

Never-throws load (missing -> silent defaults; corrupt/invalid -> defaults +
ERROR log), strict schema so an unknown key fails loudly, atomic serialized
write with a not-a-regular-file guard.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Fix the pre-existing `once` + `drain` conflict in `runOrSupervise`

**Why this is a real bug, not a refactor:** `conductor.run` checks `opts.once` at `src/conductor/conductor.ts:705` and breaks BEFORE the drain check at line 719. The supervisor builds its drain as `conductor.run({ ...runOpts, drain: true })` (`src/composition/root.ts:714`). So any caller passing `once: true` turns the supervisor's "drain the whole queue" into a single iteration. Today `run --once` with overnight enabled already hits this; Task 4 would make the daemon hit it on every trigger. Fix it first, standalone, with a regression test.

**Files:**
- Modify: `src/composition/root.ts:736-746` (`runOrSupervise`)
- Test: `src/composition/root.test.ts` (add to the existing file; if no `runOrSupervise` describe block exists, add one)

- [ ] **Step 1: Read the current implementation**

Read `src/composition/root.ts:704-746` so the edit lands in the right closure. `buildSupervisorDeps(runOpts)` spreads `runOpts` into the drain; `runOrSupervise` passes its argument straight through.

- [ ] **Step 2: Write the failing test**

Add to `src/composition/root.test.ts`. If the file has no harness for building a root with a fake conductor, prefer testing the extracted helper instead: extract the option-stripping into an exported pure function (below) and test that directly — a pure function is the honest unit here.

```ts
import { supervisorRunOpts } from "./root.js";

describe("supervisorRunOpts", () => {
  it("strips `once` so the supervisor's drain is a real drain", () => {
    // conductor.run breaks on `once` BEFORE it evaluates `drain`
    // (conductor.ts:705 vs :719), so `{once:true, drain:true}` runs ONE
    // iteration -- which would silently reduce the overnight sweep to a
    // single task.
    expect(supervisorRunOpts({ once: true })).toEqual({});
  });

  it("keeps every other bound", () => {
    expect(supervisorRunOpts({ once: true, maxIterations: 5 })).toEqual({ maxIterations: 5 });
  });

  it("handles an absent options object", () => {
    expect(supervisorRunOpts(undefined)).toEqual({});
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/composition/root.test.ts -t supervisorRunOpts`
Expected: FAIL — `supervisorRunOpts is not a function` / import error.

- [ ] **Step 4: Implement**

Add near the top level of `src/composition/root.ts` (module scope, exported):

```ts
/**
 * The run options the overnight supervisor may inherit. `once` is DROPPED:
 * `conductor.run` evaluates `once` before `drain` (conductor.ts:705 vs :719), so
 * an inherited `once: true` would collapse the supervisor's queue-wide drain into
 * a single iteration. Every other bound (maxIterations, ...) is preserved -- the
 * operator's limits still apply, only the incompatible one is removed.
 */
export function supervisorRunOpts(runOpts: ConductorRunOptions | undefined): ConductorRunOptions {
  const { once: _once, ...rest } = runOpts ?? {};
  return rest;
}
```

Then change `runOrSupervise` (`src/composition/root.ts:740-746`) to use it:

```ts
  const runOrSupervise = async (runOpts?: ConductorRunOptions): Promise<void> => {
    if (cfg.autonomy.overnight.enabled) {
      await superviseOvernight(buildSupervisorDeps(supervisorRunOpts(runOpts)));
    } else {
      await conductor.run(runOpts);
    }
  };
```

The non-overnight branch keeps passing `runOpts` verbatim — the plain `run` path must stay byte-identical.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/composition/root.test.ts`
Expected: PASS, including the three new cases and every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add src/composition/root.ts src/composition/root.test.ts
git commit -m "fix(autonomy): drop \`once\` from the supervisor's inherited run options

conductor.run breaks on \`once\` before it evaluates \`drain\`
(conductor.ts:705 vs :719), so an inherited \`once: true\` collapsed the
overnight supervisor's queue-wide drain into a single iteration. Pre-existing
for \`run --once\`; would have hit every daemon trigger once the daemon routes
through runOrSupervise.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Presence port + AND semantics in `runOrSupervise`

**Files:**
- Modify: `src/composition/root.ts` (the `buildProjectRoot` signature and `runOrSupervise`)
- Test: `src/composition/root.test.ts`

The presence read must be injectable (tests must not touch `~`), have a real default (production callers keep working unchanged), and be read FRESH on every call — that is what makes a toggle click take effect without any cache invalidation.

- [ ] **Step 1: Write the failing truth-table test**

Add to `src/composition/root.test.ts`. Test the decision as a pure function so it needs no filesystem or conductor:

```ts
import { shouldSupervise } from "./root.js";

describe("shouldSupervise (overnight truth table)", () => {
  const cases: { presence: boolean; optIn: boolean; expected: boolean }[] = [
    { presence: false, optIn: false, expected: false },
    { presence: false, optIn: true, expected: false },
    { presence: true, optIn: false, expected: false },
    { presence: true, optIn: true, expected: true },
  ];
  for (const { presence, optIn, expected } of cases) {
    it(`presence=${presence} optIn=${optIn} -> ${expected}`, async () => {
      expect(await shouldSupervise(async () => presence, optIn)).toBe(expected);
    });
  }

  it("falls back to a plain run when the presence read throws", async () => {
    // Fail-direction: never fall INTO autonomy by accident.
    expect(
      await shouldSupervise(async () => {
        throw new Error("unreadable");
      }, true),
    ).toBe(false);
  });

  it("does not read presence when the project has not opted in", async () => {
    // Cheap short-circuit AND: no file read for the overwhelmingly common case.
    let reads = 0;
    await shouldSupervise(async () => {
      reads++;
      return true;
    }, false);
    expect(reads).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/composition/root.test.ts -t shouldSupervise`
Expected: FAIL — `shouldSupervise is not a function`.

- [ ] **Step 3: Implement**

Add at module scope in `src/composition/root.ts`:

```ts
/** Reads daemon-global operator presence. Injected so tests never touch `~`, and
 *  called FRESH per run so a toggle click takes effect on the next trigger with
 *  no cache to invalidate (unlike `cfg`, which a live ProjectRoot captures once
 *  -- see hub.ts:26). */
export type PresenceReader = () => Promise<boolean>;

/**
 * Overnight autonomy runs on the AND of daemon-global operator presence and the
 * project's own opt-in (spec 2026-07-19). Order matters twice over: the project
 * opt-in is checked first so the common attended case does no file IO, and ANY
 * presence-read failure resolves to `false` -- the system must never fall INTO
 * autonomy by accident.
 */
export async function shouldSupervise(presence: PresenceReader, projectOptIn: boolean): Promise<boolean> {
  if (!projectOptIn) return false;
  try {
    return await presence();
  } catch {
    return false;
  }
}
```

Give `buildProjectRoot` an optional injected reader with a production default. Find its current signature (around `src/composition/root.ts:166`) and extend it:

```ts
export async function buildProjectRoot(
  repoRoot: string,
  opts?: { presence?: PresenceReader },
): Promise<ProjectRoot> {
  // ...existing body...
  const presence: PresenceReader =
    opts?.presence ??
    (async () => (await loadSettings(defaultSettingsFile(homedir()), log)).overnight.enabled);
```

Add the imports at the top of the file:

```ts
import { homedir } from "node:os";
import { loadSettings, defaultSettingsFile } from "../settings/settings.js";
```

(`homedir` may already be imported — check before adding a duplicate.)

Then rewrite `runOrSupervise`:

```ts
  const runOrSupervise = async (runOpts?: ConductorRunOptions): Promise<void> => {
    if (await shouldSupervise(presence, cfg.autonomy.overnight.enabled)) {
      await superviseOvernight(buildSupervisorDeps(supervisorRunOpts(runOpts)));
    } else {
      await conductor.run(runOpts);
    }
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/composition/root.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/composition/root.ts src/composition/root.test.ts
git commit -m "feat(autonomy): AND global operator presence with the per-project opt-in

runOrSupervise now supervises only when the project opted in AND the daemon-global
presence flag is set. The presence read is injected and read fresh per run (no
cache to invalidate); a project that has not opted in does no file IO, and any
read failure resolves to a plain attended run.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Route the daemon's run trigger through `runOrSupervise`

Today `trigger` (`src/composition/root.ts:822`) calls `conductor.run` directly, so the daemon can never reach the supervisor — the whole reason this slice exists.

**Files:**
- Modify: `src/composition/root.ts:816-830` (the `caps` object in `buildOrchestrator`) and the `buildOrchestrator` call site
- Test: `src/composition/root.test.ts`

**R1 boundary note:** `trigger` remains the orchestrator's ONLY enforcement handle and still only STARTS a bounded loop. Swapping which bounded loop it starts does not widen the orchestrator's dependency surface — adr/003 R1 and ADR-004 tenet 6 are untouched.

- [ ] **Step 1: Write the failing test**

`buildOrchestrator` receives its collaborators via `ctx`. Add a `trigger` to that context instead of reaching for the conductor, and test that the orchestrator's capability forwards to it:

```ts
describe("orchestrator trigger routing", () => {
  it("routes the orchestrator's trigger through the injected run entry, not conductor.run", async () => {
    const calls: unknown[] = [];
    const caps = buildOrchestratorCaps({
      // ...whatever the existing test helper passes...
      runEntry: async (opts) => {
        calls.push(opts);
      },
    });
    await caps.trigger();
    expect(calls).toEqual([{ once: true }]);
  });
});
```

Adapt the helper names to what `src/composition/root.test.ts` already uses. If `buildOrchestrator` is not exported for testing, assert the wiring at the `buildProjectRoot` level with a fake conductor and a fake presence reader instead: with `presence -> true` and a config that opted in, a `trigger()` must reach `superviseOvernight`'s drain rather than a single `conductor.run`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/composition/root.test.ts -t "trigger routing"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `buildOrchestrator`'s `ctx` type, replace the direct conductor dependency for triggering with an injected entry point:

```ts
function buildOrchestrator(ctx: {
  cfg: HarnessConfig;
  repoRoot: string;
  repo: FileBlackboardRepository;
  conductor: Conductor;
  /** The overnight-aware run entry (`runOrSupervise`). Still the orchestrator's
   *  ONLY enforcement handle and still only STARTS a bounded loop -- adr/003 R1
   *  is unchanged; overnight merely decides WHICH bounded loop starts. */
  runEntry: (opts?: ConductorRunOptions) => Promise<void>;
  log: Logger;
}): { handleIntent(intent: string): Promise<OrchestratorResult> } {
```

and change the capability (`src/composition/root.ts:822`):

```ts
    trigger: (opts) => ctx.runEntry(opts ?? { once: true }),
```

At the `buildOrchestrator` call site inside `buildProjectRoot`, pass `runEntry: runOrSupervise`. **Ordering:** `runOrSupervise` is a `const` arrow function declared at line ~740, and the orchestrator is built lazily inside `getOrchestrator()`; confirm the call site runs after the declaration. If the orchestrator is constructed eagerly above line 740, pass a thunk (`runEntry: (opts) => runOrSupervise(opts)`) so the reference resolves at call time rather than construction time — this is exactly the eager-construction class of bug in gotcha `[refactor/extraction-eagerness]`.

Leave `src/index.ts:200` (`root.conductor.run({ drain: true })`, the reply-B re-drain) **unchanged**: an operator answering an escalation is present by definition.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/composition/`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite — this task changes a shared path**

Run: `npm test`
Expected: PASS, no regressions (baseline is 1119 tests / 3 skipped, plus everything added so far).

- [ ] **Step 6: Commit**

```bash
git add src/composition/root.ts src/composition/root.test.ts
git commit -m "feat(autonomy): route the daemon's orchestrator trigger through runOrSupervise

The daemon previously called conductor.run directly, so the overnight supervisor
was reachable only from the CLI run verb. trigger now starts the overnight-aware
entry; it is still the orchestrator's only enforcement handle and still only
starts a bounded loop (adr/003 R1 unchanged). The reply-B re-drain stays on the
plain conductor -- an operator answering an escalation is present by definition.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Opt-in counter (honest reporting)

The UI must never claim overnight is armed when no project opted in. This counts opted-in projects by reading each registered project's `.autodev/config.yaml` **directly** — building composition roots would be far more expensive (`hub.list()` deliberately never forces a build, `src/hub/hub.ts:16-18`).

**Files:**
- Create: `src/settings/opt-in-count.ts`
- Test: `src/settings/opt-in-count.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countOptedIn } from "./opt-in-count.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autodev-optin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function project(name: string, yaml: string | null): Promise<string> {
  const p = join(dir, name);
  await mkdir(join(p, ".autodev"), { recursive: true });
  if (yaml !== null) await writeFile(join(p, ".autodev", "config.yaml"), yaml, "utf8");
  return p;
}

describe("countOptedIn", () => {
  it("counts only projects whose config opts in", async () => {
    const a = await project("a", "autonomy:\n  overnight:\n    enabled: true\n");
    const b = await project("b", "autonomy:\n  overnight:\n    enabled: false\n");
    const c = await project("c", "stateDir: .autodev\n"); // absent -> default false
    expect(await countOptedIn([a, b, c])).toEqual({ optedIn: 1, total: 3 });
  });

  it("counts an unreadable or missing config as NOT opted in, without throwing", async () => {
    const a = await project("a", "autonomy:\n  overnight:\n    enabled: true\n");
    const b = await project("b", null); // no config.yaml at all
    const c = await project("c", "\t: not: valid: yaml\n");
    expect(await countOptedIn([a, b, c])).toEqual({ optedIn: 1, total: 3 });
  });

  it("returns zeroes for an empty registry", async () => {
    expect(await countOptedIn([])).toEqual({ optedIn: 0, total: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/settings/opt-in-count.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

Create `src/settings/opt-in-count.ts`:

```ts
/**
 * How many registered projects have opted in to overnight autonomy.
 *
 * Reads each project's `.autodev/config.yaml` DIRECTLY rather than building
 * composition roots: `hub.list()` deliberately never forces a build (hub.ts:16-18),
 * and forcing N roots just to render a count would be a real cost. The narrow
 * duplication is deliberate -- it reads one field and treats EVERY failure as
 * not-opted-in, so drift can only ever under-report, never claim autonomy that
 * is not armed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface OptInCount {
  optedIn: number;
  total: number;
}

async function optedIn(repoRoot: string): Promise<boolean> {
  try {
    const text = await readFile(join(repoRoot, ".autodev", "config.yaml"), "utf8");
    const doc = parseYaml(text) as { autonomy?: { overnight?: { enabled?: unknown } } } | null;
    return doc?.autonomy?.overnight?.enabled === true;
  } catch {
    return false;
  }
}

export async function countOptedIn(repoRoots: readonly string[]): Promise<OptInCount> {
  const flags = await Promise.all(repoRoots.map(optedIn));
  return { optedIn: flags.filter(Boolean).length, total: repoRoots.length };
}
```

Note the hardcoded `.autodev`: a project may configure a different `stateDir`, but `config.yaml` itself always lives at `.autodev/config.yaml` — that is where `loadConfigWithRaw` reads it from (`src/config/config.ts:14-43`).

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run src/settings/opt-in-count.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings/opt-in-count.ts src/settings/opt-in-count.test.ts
git commit -m "feat(settings): count projects opted in to overnight autonomy

Reads each registered project's config.yaml directly (no root builds) and treats
every failure as not-opted-in, so the count can only under-report -- it must never
claim autonomy that is not actually armed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `GET` / `PATCH /settings` routes

**Files:**
- Modify: `src/api/server.ts` (a new `settings` port on `ApiServerDeps`, two handlers, two dispatch lines)
- Modify: `src/index.ts` (wire the port)
- Test: `src/api/server.test.ts`

Follow the shape of `handleSystemGit` (`src/api/server.ts:1246-1253`) for the GET and `handlePatchConfig` (`:1366-1417`) for the PATCH.

- [ ] **Step 1: Write the failing tests**

Add to `src/api/server.test.ts`, mirroring the existing `describe("GET /system/git")` block's style:

```ts
describe("GET /settings", () => {
  it("404s without a settings port", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/settings`)).status).toBe(404);
  });

  it("200s with the settings plus opt-in counts", async () => {
    handle = createApiServer(
      projectDeps({ repo, stateDir }, {
        settings: {
          read: async () => ({ overnight: { enabled: true }, optedInProjects: 1, totalProjects: 3 }),
          write: async () => ({ overnight: { enabled: true }, optedInProjects: 1, totalProjects: 3 }),
        },
      }),
    );
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      overnight: { enabled: true },
      optedInProjects: 1,
      totalProjects: 3,
    });
  });
});

describe("PATCH /settings", () => {
  const okPort = () => ({
    read: async () => ({ overnight: { enabled: false }, optedInProjects: 0, totalProjects: 0 }),
    write: async (s: { overnight: { enabled: boolean } }) => ({
      overnight: { enabled: s.overnight.enabled },
      optedInProjects: 0,
      totalProjects: 0,
    }),
  });

  it("writes and returns the same shape as GET", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { settings: okPort() }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: true } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      overnight: { enabled: true },
      optedInProjects: 0,
      totalProjects: 0,
    });
  });

  it("400s on an unknown key", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { settings: okPort() }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: true }, bogus: 1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_settings");
  });

  it("400s on a wrongly-typed value", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }, { settings: okPort() }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: "yes" } }),
    });
    expect(res.status).toBe(400);
  });

  it("500s when the write fails", async () => {
    handle = createApiServer(
      projectDeps({ repo, stateDir }, {
        settings: {
          read: okPort().read,
          write: async () => {
            throw new Error("disk on fire");
          },
        },
      }),
    );
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overnight: { enabled: true } }),
    });
    expect(res.status).toBe(500);
  });
});
```

You will need to extend the `projectDeps` test helper to accept a `settings` port — follow how it already accepts `admin`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/api/server.test.ts -t "/settings"`
Expected: FAIL — the routes 404 / the helper rejects the `settings` key.

- [ ] **Step 3: Implement the port and handlers**

In `src/api/server.ts`, add to the exported deps interface (next to `admin`):

```ts
/** Daemon-global settings (spec 2026-07-19). Absent -> the routes 404, exactly
 *  like the admin-gated routes. */
settings?: {
  read(): Promise<GlobalSettingsView>;
  write(next: { overnight: { enabled: boolean } }): Promise<GlobalSettingsView>;
};
```

and export the view type:

```ts
/** The body of BOTH GET and PATCH /settings: the stored settings plus honest
 *  opt-in counts, so one response can be written straight into the UI cache. */
export interface GlobalSettingsView {
  overnight: { enabled: boolean };
  optedInProjects: number;
  totalProjects: number;
}
```

Add the write-form schema near the other request schemas:

```ts
/** `.strict()`: an unknown key is a loud 400, never a silent drop (same
 *  philosophy as ScaffoldFormSchema and the root config schema). */
const SettingsFormSchema = z
  .object({ overnight: z.object({ enabled: z.boolean() }).strict() })
  .strict();
```

Add the handlers next to `handleSystemGit`:

```ts
/** GET /settings — daemon-global operator presence + opt-in counts. */
async function handleGetSettings(res: ServerResponse): Promise<void> {
  if (!deps.settings) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  sendJson(res, 200, await deps.settings.read());
}

/** PATCH /settings — set operator presence. Returns the same shape as GET so the
 *  UI can cache the response without a refetch. */
async function handlePatchSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!deps.settings) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const body = await readJsonBody(req, res);
  if (body === undefined) return; // readJsonBody already answered (413/400)
  const parsed = SettingsFormSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: parsed.error.message, code: "invalid_settings" });
    return;
  }
  try {
    sendJson(res, 200, await deps.settings.write(parsed.data));
  } catch (err) {
    sendJson(res, 500, { error: `failed writing settings: ${String(err)}` });
  }
}
```

Check `readJsonBody`'s actual "already answered" sentinel in this file before copying the `undefined` check — match whatever `handlePatchConfig` does.

Add the dispatch lines beside the other global routes (after the `/system/git` block at `:2316`):

```ts
    if (req.method === "GET" && (url.pathname === "/settings" || url.pathname === "/settings/")) {
      return void (await handleGetSettings(res));
    }
    if (req.method === "PATCH" && (url.pathname === "/settings" || url.pathname === "/settings/")) {
      return void (await handlePatchSettings(req, res));
    }
```

These must sit BEFORE the `/^\/projects\/([^/]+)(\/.*)?$/` match (they do not collide, but keep global routes grouped).

- [ ] **Step 4: Wire the port in `src/index.ts`**

Inside the `serve` branch, next to `registryFile` (`src/index.ts:129`):

```ts
    const settingsFile = defaultSettingsFile(homedir());
```

and add to the `createApiServer({...})` call, next to `admin`:

```ts
      settings: {
        read: async () => {
          const s = await loadSettings(settingsFile, log);
          const { projects } = await loadRegistry(registryFile, log);
          const counts = await countOptedIn(projects.map((p) => p.path));
          return { overnight: s.overnight, optedInProjects: counts.optedIn, totalProjects: counts.total };
        },
        write: async (next) => {
          await saveSettings(settingsFile, next);
          const { projects } = await loadRegistry(registryFile, log);
          const counts = await countOptedIn(projects.map((p) => p.path));
          return { overnight: next.overnight, optedInProjects: counts.optedIn, totalProjects: counts.total };
        },
      },
```

Imports to add at the top of `src/index.ts`:

```ts
import { loadSettings, saveSettings, defaultSettingsFile } from "./settings/settings.js";
import { countOptedIn } from "./settings/opt-in-count.js";
```

No `hub.evict` is needed — nothing caches settings. That is the point of the read-through design.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/api/server.test.ts`
Expected: PASS, all pre-existing server tests included.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/api/server.ts src/api/server.test.ts src/index.ts
git commit -m "feat(api): GET/PATCH /settings for daemon-global operator presence

Both verbs return the settings plus honest opt-in counts so the UI caches one
response without a refetch. Strict form schema -> 400 invalid_settings on an
unknown or wrongly-typed key; a write failure is a 500. No hub eviction needed:
presence is read through, never cached.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Make the per-project opt-in writable and readable

`autonomy` is currently absent from both the write whitelist and the read projection, so the opt-in cannot be set or displayed from the UI at all.

**Files:**
- Modify: `src/registry/scaffold.ts:26-72` (`ScaffoldFormSchema`)
- Modify: `src/api/config-view.ts:21-57` (`buildProjectConfigView`)
- Modify: `src/api/server.ts` (`ProjectConfigView` interface)
- Test: `src/registry/scaffold.test.ts`, `src/api/config-view.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/api/config-view.test.ts`:

```ts
it("projects the overnight autonomy opt-in", () => {
  const cfg = HarnessConfigSchema.parse({ autonomy: { overnight: { enabled: true, maxAutoReworks: 2 } } });
  expect(buildProjectConfigView(cfg, false).autonomy).toEqual({ overnight: { enabled: true } });
});

it("projects the default opt-in as false", () => {
  const cfg = HarnessConfigSchema.parse({});
  expect(buildProjectConfigView(cfg, false).autonomy).toEqual({ overnight: { enabled: false } });
});
```

In `src/registry/scaffold.test.ts`:

```ts
it("accepts an autonomy opt-in in the write form", () => {
  const parsed = ScaffoldFormSchema.safeParse({ autonomy: { overnight: { enabled: true } } });
  expect(parsed.success).toBe(true);
});

it("rejects an unknown autonomy sub-key", () => {
  expect(ScaffoldFormSchema.safeParse({ autonomy: { overnight: { enable: true } } }).success).toBe(false);
});

it("does not accept maxAutoReworks from the form (YAML-only field)", () => {
  expect(ScaffoldFormSchema.safeParse({ autonomy: { overnight: { maxAutoReworks: 5 } } }).success).toBe(false);
});
```

Match the import style already used in each test file.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/api/config-view.test.ts src/registry/scaffold.test.ts`
Expected: FAIL — `autonomy` is undefined in the view; the form rejects `autonomy`.

- [ ] **Step 3: Implement**

In `src/registry/scaffold.ts`, add inside `ScaffoldFormSchema`'s object (before the closing `})` and its `.strict()`):

```ts
    // Overnight autonomy opt-in (spec 2026-07-19). ONLY `enabled` is writable from
    // the UI; `maxAutoReworks` stays a YAML-only field (YAGNI -- the operator edits
    // it directly on the rare occasion it needs tuning).
    autonomy: z
      .object({
        overnight: z.object({ enabled: z.boolean().optional() }).strict().optional(),
      })
      .strict()
      .optional(),
```

In `src/api/server.ts`, add to the `ProjectConfigView` interface:

```ts
  /** Per-project overnight-autonomy opt-in. Effective autonomy is this ANDed with
   *  daemon-global operator presence (GET /settings). */
  autonomy: { overnight: { enabled: boolean } };
```

In `src/api/config-view.ts`, add to the returned object (after `worktree`):

```ts
    autonomy: { overnight: { enabled: cfg.autonomy.overnight.enabled } },
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run src/api/config-view.test.ts src/registry/scaffold.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite (the config view has many consumers)**

Run: `npm test`
Expected: PASS. If a test asserts `buildProjectConfigView`'s output with `toEqual`, it will now fail on the added key — update those assertions to include `autonomy`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/registry/scaffold.ts src/api/config-view.ts src/api/server.ts src/registry/scaffold.test.ts src/api/config-view.test.ts
git commit -m "feat(config): expose the overnight autonomy opt-in for read and write

autonomy was absent from both the write whitelist (a PATCH carrying it 400'd) and
the read projection, so the per-project opt-in could not be set or displayed.
Only \`enabled\` is writable; maxAutoReworks stays YAML-only.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Vendor the shadcn `switch` primitive

**shadcn-first (AGENTS.md):** `switch` is the purpose-built primitive and is NOT yet vendored. `toggle-group` (vendored) models segmented choice and backs the theme selector; `checkbox` (vendored) is form-field semantics. Neither fits a mode switch. Record this in the commit message.

**Files:**
- Create: `ui/src/components/ui/switch.tsx`

- [ ] **Step 1: Get the add command from the shadcn MCP**

Use the shadcn MCP tool `get_add_command_for_items` for item `switch` against the project's configured registry. The project's style is `base-nova` (shadcn on Base UI) — per gotcha `[ui/base-nova-ports-catalog-to-base-ui]`, the MCP's default-style metadata reports Radix deps, but `base-nova` ships Base UI ports; fetch the style-specific item, not the default-style one.

- [ ] **Step 2: Vendor the component**

Per gotcha `[ui/shadcn-cli-vendor-windows]`, do NOT run `npx shadcn add` non-interactively on this box — it rewrites `registryDependencies` and Windows' case-insensitive FS makes its stock `button.tsx` collide with this project's custom `Button.tsx`, producing an overwrite prompt that `--yes` cannot bypass. Instead:

1. Fetch the item JSON for the `base-nova` style.
2. Write `files[0].content` to `ui/src/components/ui/switch.tsx`.
3. `npm --prefix ui install <declared dep>` if the item declares one not already present (check `ui/package.json` first — `@base-ui-components/react` is likely already there).
4. Rewrite site-internal aliases to this project's conventions: `@/lib/utils` for `cn`, `@/components/ui/Button` for any Button import, lucide icons instead of registry placeholders.

- [ ] **Step 3: Verify it compiles**

Run: `npm --prefix ui run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/ui/switch.tsx ui/package.json ui/package-lock.json
git commit -m "chore(ui): vendor the shadcn switch primitive (base-nova)

shadcn-first check: switch is the purpose-built primitive for a mode toggle.
toggle-group (vendored) models segmented choice and backs the theme selector;
checkbox is form-field semantics. Vendored by hand per
[ui/shadcn-cli-vendor-windows].

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: UI data layer — types, client, hooks

**Files:**
- Modify: `ui/src/lib/api.ts`
- Modify: `ui/src/lib/queries.ts`

- [ ] **Step 1: Add the types and client methods**

In `ui/src/lib/api.ts`, add near the other response types:

```ts
/** Daemon-global settings + honest opt-in counts. Returned by BOTH GET and
 *  PATCH /settings, so a mutation response can be cached without a refetch. */
export interface GlobalSettingsView {
  overnight: { enabled: boolean };
  optedInProjects: number;
  totalProjects: number;
}
```

Extend `ProjectConfigView` with:

```ts
  autonomy: { overnight: { enabled: boolean } };
```

and `ProjectConfigForm` with:

```ts
  autonomy?: { overnight?: { enabled?: boolean } };
```

Add to the `api` object, beside `getSystemGit` (`ui/src/lib/api.ts:417`):

```ts
  /** Daemon-global operator presence. 404s when the daemon has no settings port. */
  getSettings: () => req<GlobalSettingsView>("/settings"),

  /** Set operator presence. Returns the same shape as getSettings. */
  updateSettings: (next: { overnight: { enabled: boolean } }) =>
    req<GlobalSettingsView>("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    }),
```

- [ ] **Step 2: Add the hooks**

In `ui/src/lib/queries.ts`, add the key to `qk`:

```ts
  settings: ["settings"] as const,
```

and the hooks beside `useSystemGit` (`ui/src/lib/queries.ts:259`):

```ts
/** Daemon-global operator presence + opt-in counts. */
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: api.getSettings });

/** Flip operator presence. The server returns the fresh view (counts included),
 *  so it goes straight into the cache; on failure the cache is invalidated so the
 *  switch snaps back to the daemon's real state rather than a hopeful one. */
export const useUpdateSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: { overnight: { enabled: boolean } }) => api.updateSettings(next),
    onSuccess: (data) => qc.setQueryData(qk.settings, data),
    onError: () => void qc.invalidateQueries({ queryKey: qk.settings }),
  });
};
```

Finally, extend `useUpdateProjectConfig`'s `onSuccess` (`queries.ts:233-236`) so a changed opt-in refreshes the global counts:

```ts
    onSuccess: (data) => {
      qc.setQueryData(qk.config(projectId), data); // optimistic: server already returned the fresh view
      void qc.invalidateQueries({ queryKey: qk.projects });
      // The opt-in may have changed -> the sidebar's "N of M projects" is stale.
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix ui run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/api.ts ui/src/lib/queries.ts
git commit -m "feat(ui): settings client + hooks for operator presence

useSettings/useUpdateSettings follow the useSystemGit/useUpdateProjectConfig
idioms; a project-config write invalidates the settings query so the opt-in
count never goes stale.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: The sidebar toggle

**Files:**
- Create: `ui/src/components/OvernightToggle.tsx`
- Modify: `ui/src/components/Sidebar.tsx:95-101` (footer)

- [ ] **Step 1: Write the component**

Create `ui/src/components/OvernightToggle.tsx`:

```tsx
import { Moon } from "lucide-react";
import { useSettings, useUpdateSettings } from "@/lib/queries";
import { Switch } from "@/components/ui/switch";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";

/**
 * Global operator-presence switch (ADR-004 tenet 5, spec 2026-07-19). Presence is
 * a property of the OPERATOR, not a project, so this is daemon-global — but
 * overnight autonomy runs on the AND of this and each project's own opt-in.
 *
 * The sub-line is the honesty mechanism, not decoration: flipping this on while
 * no project has opted in means nothing happens all night, and that state must be
 * visible HERE, on the screen where the operator clicked
 * ([ui/fire-and-forget-action-needs-feedback-at-point-of-action]).
 */
export function OvernightToggle() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const { state } = useSidebar();

  const enabled = settings.data?.overnight.enabled ?? false;
  const optedIn = settings.data?.optedInProjects ?? 0;
  const total = settings.data?.totalProjects ?? 0;
  const armed = enabled && optedIn > 0;

  const detail = !settings.data
    ? "…"
    : !enabled
      ? "off · attended"
      : optedIn === 0
        ? "on · no project opted in"
        : `on · ${optedIn} of ${total} projects`;

  const toggle = () => update.mutate({ overnight: { enabled: !enabled } });

  // Collapsed icon rail: the switch has no room, so the whole row becomes one
  // icon button carrying the same state and the sub-line as its tooltip.
  if (state === "collapsed") {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={`Overnight: ${detail}`}
            onClick={toggle}
            disabled={update.isPending}
            aria-label={`Overnight autonomy: ${detail}`}
          >
            <Moon
              className={
                armed
                  ? "size-4 text-primary"
                  : enabled
                    ? "size-4 text-uncertain"
                    : "size-4 text-muted-foreground"
              }
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Moon className={armed ? "size-4 shrink-0 text-primary" : "size-4 shrink-0 text-muted-foreground"} />
      <div className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate text-sm font-medium text-sidebar-foreground">Overnight</span>
        <span
          className={
            enabled && optedIn === 0
              ? "truncate font-mono text-[10px] text-uncertain"
              : "truncate font-mono text-[10px] text-muted-foreground"
          }
        >
          {detail}
        </span>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={toggle}
        disabled={update.isPending || settings.isError}
        aria-label="Overnight autonomy"
      />
    </div>
  );
}
```

**Verify before assuming:**
- `useSidebar()` and its `state` value (`"expanded" | "collapsed"`) — confirm against `ui/src/components/ui/sidebar.tsx`. If the hook is named differently, use the same `group-data-[collapsible=icon]:` CSS approach the rest of `Sidebar.tsx` uses instead of a JS branch.
- The vendored `Switch`'s prop names (`checked` / `onCheckedChange`) — read `ui/src/components/ui/switch.tsx` after Task 8 and match exactly. Base UI passes `(boolean, eventDetails)` to the change handler; a zero-arg arrow like the `toggle` above is safe.
- `text-uncertain` — confirm this token exists (used elsewhere for amber/warning tone, e.g. `toneVar.uncertain` in `@/lib/status`). If it does not exist as a Tailwind class, use `style={{ color: toneVar.uncertain }}` the way `SettingsPopover.tsx:68` does.

- [ ] **Step 2: Mount it in the sidebar footer**

In `ui/src/components/Sidebar.tsx`, add the import and place the toggle above the settings menu:

```tsx
import { OvernightToggle } from "./OvernightToggle";
```

```tsx
      {/* Operator presence (global) + settings/daemon status */}
      <SidebarFooter>
        <OvernightToggle />
        <SidebarSettingsMenu
          projectId={activeProjectId}
          projectName={activeProject?.name}
          conn={conn}
        />
      </SidebarFooter>
```

- [ ] **Step 3: Typecheck and build**

Run: `npm --prefix ui run typecheck && npm --prefix ui run build`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/OvernightToggle.tsx ui/src/components/Sidebar.tsx
git commit -m "feat(ui): global overnight presence toggle in the sidebar footer

Sits with the daemon status badge -- the app's only global chrome (documented
divergence from ADR-004's literal 'top bar': there is no global header). The
sub-line reports the real armed state, including the 'on but no project opted in'
case that would otherwise be a silent no-op all night.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Per-project opt-in row in project settings

**Files:**
- Modify: `ui/src/views/ProjectSettingsView.tsx`

This screen uses a draft/diff editing model: `EditDraft` holds the working copy, `draftFrom(config)` seeds it, `buildDiff(config, draft)` emits ONLY changed fields, and `save()` PATCHes the diff.

- [ ] **Step 1: Extend the draft**

Add to the `EditDraft` interface (beside `isolationSkills`, `ProjectSettingsView.tsx:52-55`):

```ts
  /** Overnight autonomy opt-in (spec 2026-07-19). Effective only when the global
   *  presence switch is also on. */
  autonomyOvernight: boolean;
```

Add to `draftFrom` (beside `isolationSkills`, `:75-77`):

```ts
    autonomyOvernight: config.autonomy.overnight.enabled,
```

- [ ] **Step 2: Emit it in the diff**

Add to `buildDiff`, right after the isolation block (`:150-160`):

```ts
  // Overnight opt-in: same send-only-changed contract -- an untouched toggle
  // sends no `autonomy` key, so the backend never rewrites it.
  if (draft.autonomyOvernight !== config.autonomy.overnight.enabled) {
    diff.autonomy = { overnight: { enabled: draft.autonomyOvernight } };
  }
```

- [ ] **Step 3: Render the row**

Add a section to the rendered form, following the existing isolation checkboxes' markup exactly (read them first and mirror their `Checkbox` usage — remember gotcha `[ui/base-ui-checkbox-wrapping-label]`: the checkbox and its text must be wrapped in ONE `<label>`, a sibling `htmlFor` label does not toggle a Base UI checkbox):

```tsx
<SettingsSection title="Autonomy">
  <label className="flex items-start gap-2.5 py-1.5">
    <Checkbox
      checked={draft.autonomyOvernight}
      onCheckedChange={(v) => patchDraft({ autonomyOvernight: v })}
      disabled={!editing}
    />
    <span className="grid gap-0.5">
      <span className="text-[13px] text-foreground">Overnight autonomy</span>
      <span className="text-[11px] text-muted-foreground">
        Allow this project to run unattended when overnight mode is on. Both must be
        set: this opt-in AND the global Overnight switch in the sidebar. A run already
        in flight keeps the config it started with.
      </span>
    </span>
  </label>
</SettingsSection>
```

When not editing, render it as a read-only `SettingsRow` if that is what the surrounding sections do — match the file's existing editing/read-only convention rather than inventing a third one.

- [ ] **Step 4: Typecheck and build**

Run: `npm --prefix ui run typecheck && npm --prefix ui run build`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add ui/src/views/ProjectSettingsView.tsx
git commit -m "feat(ui): per-project overnight autonomy opt-in row

Follows the screen's send-only-changed diff contract; the description states the
AND semantics and the in-flight-run caveat explicitly.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end integration test

Unit tests prove each piece; this proves the wiring — a real settings file plus a real `ProjectRoot` actually changes which loop runs. This is the test class that caught real bugs in s42/s44 (fakes cannot).

**Files:**
- Create: `src/settings/presence.integration.test.ts`

- [ ] **Step 1: Write the test**

Model it on `src/autonomy/overnight-supervisor.integration.test.ts` (read that file first for the temp-repo helpers it already has).

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings } from "./settings.js";
import { shouldSupervise } from "../composition/root.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "autodev-presence-int-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("presence read-through", () => {
  it("a toggle written to disk is visible to the very next read (no cache)", async () => {
    const file = join(dir, "settings.json");
    const presence = async () => (await loadSettings(file)).overnight.enabled;

    expect(await shouldSupervise(presence, true)).toBe(false); // no file yet
    await saveSettings(file, { overnight: { enabled: true } });
    expect(await shouldSupervise(presence, true)).toBe(true); // same reader, no rebuild
    await saveSettings(file, { overnight: { enabled: false } });
    expect(await shouldSupervise(presence, true)).toBe(false);
  });

  it("a project that has not opted in never supervises, whatever the global flag says", async () => {
    const file = join(dir, "settings.json");
    await saveSettings(file, { overnight: { enabled: true } });
    const presence = async () => (await loadSettings(file)).overnight.enabled;
    expect(await shouldSupervise(presence, false)).toBe(false);
  });

  it("a corrupt settings file degrades to attended rather than autonomous", async () => {
    const file = join(dir, "settings.json");
    await writeFile(file, "{corrupt", "utf8");
    const presence = async () => (await loadSettings(file)).overnight.enabled;
    expect(await shouldSupervise(presence, true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/settings/presence.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Full gate**

Run each and confirm green before committing:

```bash
npm test
npm run typecheck
npm run build
npm run build:ui
```

Expected: full suite green (baseline 1119 + everything added), typecheck clean, BOTH bundles built. Building both is mandatory before any live-prove — a UI-only build leaves the served daemon stale and a new route 404s with green tests (gotcha `[build/stale-dist-backend]`).

- [ ] **Step 4: Commit**

```bash
git add src/settings/presence.integration.test.ts
git commit -m "test(settings): integration proof that presence is genuinely read-through

A toggle written to disk changes the very next decision with no rebuild, a
non-opted-in project never supervises, and a corrupt settings file degrades to
attended rather than autonomous.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Independent codex review gate

Not optional — this is the project's whole thesis (AGENTS.md: self-critique is never the gate).

- [ ] **Step 1: Run the critic**

Dispatch the `codex:codex-rescue` subagent over the full branch diff (`git diff main...HEAD`), **pinned to `--model gpt-5.6-luna`** (gotcha `[critic/gpt-5.6-variant-behaviors]`: sol false-blocks correct changes, terra misses real bugs; never let the gate drift onto the CLI default).

- [ ] **Step 2: Triage findings**

Every finding is either fixed or declined **with a rationale verified against the real code**. Watch for the known false positive: the inline-diff transport can strip string quotes and `+` prefixes, producing a bogus "syntactically invalid" blocker (gotcha `[critic/codex]`, hit twice in s42) — the tell is a doubled comma. Verify against `npm run typecheck` / the built bundle before patching anything on a syntax claim.

- [ ] **Step 3: Re-critic in-place fixes**

Any fix made in response to the review gets another codex pass. Never self-certify a critic-advised fix.

- [ ] **Step 4: Commit fixes**

One commit per fix, each with its regression test.

---

### Task 14: Live-prove through the real daemon and browser

The mandatory bar for this project: a feature is not done because tests pass, it is done when it is observable working end to end. **Operator-observable** — do not run this unattended.

**Setup:** `woodev-shipping-plugin-test` (registry `C:\Users\maksi\.autodev\projects.json`, path `D:\Projects\wordpress\woodev-shipping-plugin-test`, branch `autodev/main`). `.autodev` is git-excluded there, so seeding never dirties the tree. Drive the API from **PowerShell** (`Invoke-RestMethod`) — a foreground Bash command kills a background daemon.

- [ ] **Step 1: Start the freshly built daemon**

```bash
node dist/index.js serve
```

Confirm it binds :4319 and serves the UI. (Both bundles were built in Task 12 — if you touched backend code since, rebuild first.)

- [ ] **Step 2: Prove the three sub-line states in the browser**

1. Open the dashboard. With overnight off, the footer reads **`off · attended`**.
2. Flip the switch on. With no project opted in, it must read **`on · no project opted in`** in the warning tone. *This is the state the whole design exists to make visible — confirm it visually, do not infer it.*
3. Open the project's settings, tick **Overnight autonomy**, save. The sidebar sub-line must become **`on · 1 of 1 projects`** without a manual reload (the config write invalidates the settings query).
4. Collapse the sidebar (Ctrl/Cmd+B). Confirm the moon icon carries the state and its tooltip shows the same detail.

- [ ] **Step 3: Prove the daemon actually behaves differently — zero-LLM**

Use the s45 deterministic recipe (no worker/critic spend): seed an escalated task that must PARK — a `blocked` escalation, or a `disagreement` whose `runtime/<id>/auto-rework-count` already equals `maxAutoReworks`. Seed escalation artifacts with the REAL `parseEscalation` field labels (`**What happened:**`, `**Decision you need to make:**`, `**Cost of being wrong:**`, `**Evidence:**` plus a fenced block) — the terse `**What:**`/`**Type:**` shape parses to null and proves nothing.

With the switch **ON** and the project opted in, trigger a run through the UI. Expect `park` entries in `.autodev/decision-journal.ndjson` and zero worker runs.

- [ ] **Step 4: Prove the toggle is the thing that decides**

Flip the switch **OFF** in the browser (change nothing else — do not touch the project config). Trigger the same run again. Expect **no new decision-journal entries**: the plain conductor path ran. This is the actual claim of the feature; the contrast between steps 3 and 4 is the proof.

- [ ] **Step 5: Record the evidence**

Capture, for the session log: the daemon log lines, the two decision-journal states, and browser screenshots of all three sub-line states. Do not describe the feature as working without this evidence (`superpowers:verification-before-completion`).

- [ ] **Step 6: Restore the test repo**

Return `woodev-shipping-plugin-test` to baseline: overnight opt-in off, seeded tasks removed, tree clean on `autodev/main`. Also flip the global switch off.

---

### Task 15: Documentation and close-out

- [ ] **Step 1: Update `docs/CURRENT-STATE.md`**

Prepend an s46 block at the top, matching the existing format (what shipped, the gate results, the live-prove evidence, and the NEXT items — the remaining ADR-004 pieces: morning report, north-star doc, mandatory anti-drift critic).

- [ ] **Step 2: Prepend an entry to `docs/SESSION-LOG.md`** (10-20 lines).

- [ ] **Step 3: Compile gotchas**

Scan the session for non-obvious behaviours worth an atomic gotcha file. At least one is already known from planning: **`once` is evaluated before `drain` in `conductor.run`**, so an inherited `once: true` silently collapses a drain to one iteration. Write `docs/gotchas/<slug>.md` and add the index line to `docs/GOTCHAS.md`, bumping the count (currently 69).

- [ ] **Step 4: Commit the docs**

```bash
git add docs/
git commit -m "docs(s46): overnight presence toggle shipped — state, session log, gotchas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Open the PR**

Push the branch and open a PR summarising the slice. Then **wait for green CI and the operator's in-turn "merge PR #N"** — per the s45 confirmed stance, the agent opens the PR and merges on the operator's word; GitHub server-side auto-merge (`--auto`) is not to be set up.

---

## Notes for the implementer

- **Do not widen the enforcement boundary.** Every change here is above the gate. If a task seems to require touching the critic, the machine gate, the dirty-file fence, or the commit path, stop — that is a design error, not an implementation detail.
- **Fail-direction is not negotiable.** Every ambiguity resolves toward attended operation. A bug that makes the harness run attended when the operator wanted autonomy costs a night; a bug that makes it run autonomously when he did not costs tokens and trust.
- **Verify the shapes you were handed.** This plan quotes real line numbers as they were on `main` at `1f1f2b5`, but read the surrounding code before editing — if something does not match, trust the code and say so rather than forcing the plan's version.
