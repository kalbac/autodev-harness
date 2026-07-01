# Autodev Harness P1 — Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the proven PowerShell autodev-loop into a project-agnostic, cross-platform Node LTS + TypeScript headless daemon that reaches behavioral parity with the PS loop.

**Architecture:** A single long-lived daemon process. State lives in a file-blackboard (git-tracked `.autodev/` layout) accessed only through a `BlackboardRepository` interface (the SQLite seam). The conductor loop wires small single-responsibility modules: scheduler → worktree → worker(claude) → critic(codex) → gate → commit/escalate/retry. Worker and critic are pluggable adapters spawning external CLIs (`claude -p`, `codex exec`). Every skeleton axis has a named seam so later grafts (PR checkpoint, action-risk gate, BYOK router, SQLite projection) land without rework.

**Tech Stack:** Node 22 LTS, TypeScript (ESM, strict), vitest (test runner), zod (schema validation for config + blackboard files), `yaml` (frontmatter parse), `chokidar` (file-watch → WS push), built-in `http` + `ws` (thin API). Git via `child_process` CLI (portable, matches AO). Package manager npm.

**Oracle:** `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md` (AS-BUILT behavior, `path:line`-anchored to the PS source). Where this plan and the parity spec disagree, the parity spec wins. Design anchor: `docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md`.

**Autonomous-mode note:** Built overnight without review checkpoints. Discipline substitute: after each module, run its full test suite green, then run an independent codex review (`codex:codex-rescue`) on the module before moving on. Never self-certify a module as done without green tests + a codex pass.

---

## Design decisions locked for P1 (defaults chosen this session; reversible)

| Decision | Choice | Rationale |
|---|---|---|
| License | Apache-2.0 (`LICENSE` + `NOTICE`) | Donors are Apache/MIT; patent grant + attribution safest for code reuse |
| Config file | `.autodev/config.yaml` | Consistent with `stateDir` default `.autodev/` carried from PS |
| Module system | ESM (`"type": "module"`) | Modern Node LTS default; top-level await in daemon entry |
| Test runner | vitest | Native TS/ESM, watch mode, fast; CI matrix Win+Linux |
| Frontmatter | `yaml` package (superset of PS YAML-lite) | Real task files are already valid YAML; more robust than a hand parser |
| Git access | `child_process.execFile('git', …)` | Portable across Win/mac/Linux; matches AO; no libgit2 native dep |
| Sequential tasks | One active task at a time (parity) | Per-worktree isolation is per-task, not yet concurrent (spec §3 scheduler) |

---

## File structure

```
autodev-harness/
├─ package.json               # ESM, scripts: build/test/dev/lint
├─ tsconfig.json              # strict, NodeNext
├─ vitest.config.ts
├─ LICENSE                    # Apache-2.0
├─ NOTICE                     # attribution to donors
├─ src/
│  ├─ index.ts                # daemon entry (thin: parse args → conductor.run)
│  ├─ util/
│  │  ├─ log.ts               # structured logger, tees console + conductor.log
│  │  ├─ native.ts            # spawn/execFile wrapper → {exitCode, stdout, stderr}
│  │  ├─ git.ts               # git CLI helpers (branch, diff, add, commit, worktree)
│  │  ├─ glob.ts              # Test-GlobMatch parity (** across /, * within segment)
│  │  └─ fingerprint.ts       # SHA256 content fingerprints of changed paths
│  ├─ config/
│  │  ├─ schema.ts            # zod HarnessConfig schema + defaults
│  │  └─ config.ts            # load + validate .autodev/config.yaml, repo-root detect
│  ├─ blackboard/
│  │  ├─ types.ts             # Task, WorkerReport, Verdict, GateVerdict, Escalation types
│  │  ├─ task.ts              # parseTask (frontmatter + body), serialize
│  │  ├─ repository.ts        # BlackboardRepository interface (the state seam)
│  │  └─ file-repository.ts   # file-backed impl over .autodev/ layout
│  ├─ scheduler/
│  │  └─ scheduler.ts         # claimNextTask: atomic move, file_set + depends_on rules
│  ├─ worktree/
│  │  └─ worktree.ts          # create/teardown/mergeAfterGate per-task worktree
│  ├─ router/
│  │  └─ router.ts            # resolve model ladder (declared → cheaper sub-ladder; contract → opus)
│  ├─ worker/
│  │  ├─ adapter.ts           # WorkerAdapter interface + result types
│  │  ├─ prompt.ts            # buildWorkerPrompt (task body + feedback + rules)
│  │  └─ claude-adapter.ts    # spawn claude -p through watchdog; ladder; report+diff
│  ├─ critic/
│  │  ├─ adapter.ts           # CriticAdapter interface
│  │  ├─ verdict.ts           # verdict.json parse + zod schema
│  │  └─ codex-adapter.ts     # spawn codex exec, fenced (move worker-report out), parse
│  ├─ gate/
│  │  ├─ invariants.ts        # parse INVARIANTS.md machine block; zone-touch detection
│  │  ├─ guards.ts            # parse GUARDS.md table; guard selection by value/zone
│  │  ├─ mutation-check.ts    # flip canonical→mutated, assert RED, revert
│  │  └─ gate.ts              # machine gate: checks in order → COMMIT|RETRY|ESCALATE
│  ├─ anti-drift/
│  │  └─ anti-drift.ts        # periodic intent-vs-diff check (fixed sonnet)
│  ├─ watchdog/
│  │  └─ watchdog.ts          # runWatched: liveness (stream+heartbeat+mtime), kill tree
│  ├─ escalate/
│  │  └─ escalate.ts          # write escalations/<id>.md + outbox/telegram delivery
│  ├─ conductor/
│  │  └─ conductor.ts         # the loop: preflight, iterate, periodic, graceful exit
│  └─ api/
│     └─ server.ts            # thin http + ws over BlackboardRepository (P2 seam)
└─ test/
   └─ fixtures/               # fixture repo + seeded tasks for parity harness
```

**Rule:** each module folder owns its `*.test.ts` colocated (e.g. `src/config/config.test.ts`). The `test/` top-level dir holds only cross-module fixtures + the parity harness.

---

## Build order (spec §10) → task groups

1. Scaffold (Task 0) → `config` + `blackboard` (Tasks 1–5)
2. `worktree` (Tasks 6–7)
3. `worker` adapter + `router` (Tasks 8–11)
4. `critic` adapter + fencing (Tasks 12–14)
5. `gate` + `guards` + `mutation-check` (Tasks 15–19)
6. `watchdog` + `escalate` + `anti-drift` (Tasks 20–23)
7. `conductor` wiring (Tasks 24–26)
8. thin `api` (Task 27)
9. parity harness + cross-platform CI (Tasks 28–29)

Tasks 0–7 below are written to full TDD step granularity (this session's build target). Tasks 8–29 are specified with exact interfaces, key test cases, and parity anchors — expand each to full TDD steps when reached (interfaces here are the contract; do not drift from them).

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`, `NOTICE`, `src/index.ts`, `.gitignore` (extend existing)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "autodev-harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "chokidar": "^4.0.0",
    "ws": "^8.18.0",
    "yaml": "^2.5.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test/fixtures"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
```

- [ ] **Step 4: Add `LICENSE` (Apache-2.0 full text) and `NOTICE`**

`NOTICE` content:
```
Autodev Harness
Copyright 2026 kalbac

This product ports policies and patterns studied from, and reuses ideas from,
the following open-source projects (see docs/superpowers/donor-extraction and
references/MANIFEST.md for pinned SHAs):
  - Agent Orchestrator (worktree isolation, kanban session model)
  - OpenHands / software-agent-sdk
  - Aider
  - Open Design
Original PowerShell autodev-loop authored in the woodev_framework project.
```

- [ ] **Step 5: Write minimal `src/index.ts` (compiles, no logic yet)**

```ts
// Daemon entry. Wires args → conductor. Kept thin (parity spec §2: conductor
// owns the loop; entry only parses flags and starts it).
async function main(): Promise<void> {
  // TODO(Task 24): const conductor = await createConductor(...); await conductor.run();
  console.log("autodev-harness: not yet wired (P1 in progress)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Install deps and verify toolchain**

Run: `npm install`
Then: `npm run typecheck` → Expected: no errors.
Then: `npx vitest run` → Expected: "No test files found" (exit 0 or the no-tests notice).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts LICENSE NOTICE src/index.ts .gitignore package-lock.json
git commit -m "chore: scaffold Node LTS + TypeScript project (vitest, zod, esm)"
```

---

## Task 1: `util/native` — safe subprocess runner

**Files:** Create `src/util/native.ts`, `src/util/native.test.ts`

Parity: `_common.ps1` `Invoke-Native` — captures `{exitCode, stdout, stderr}`, never throws on non-zero exit (the PS 5.1 stderr-as-terminating-error workaround becomes "don't reject on non-zero" in Node).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { runNative } from "./native.js";

describe("runNative", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await runNative(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi");
  });

  it("captures a non-zero exit code without throwing", async () => {
    const r = await runNative(process.execPath, ["-e", "process.exit(3)"]);
    expect(r.exitCode).toBe(3);
  });

  it("captures stderr", async () => {
    const r = await runNative(process.execPath, ["-e", "process.stderr.write('boom')"]);
    expect(r.stderr).toContain("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/util/native.test.ts`
Expected: FAIL — cannot find module `./native.js`.

- [ ] **Step 3: Implement `src/util/native.ts`**

```ts
import { spawn } from "node:child_process";

export interface NativeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeOptions {
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a native process and resolve with its captured output. Never rejects on a
 * non-zero exit code — the caller inspects `exitCode` (parity with the PS
 * `Invoke-Native` stderr-as-terminating-error workaround).
 */
export function runNative(
  command: string,
  args: string[],
  options: NativeOptions = {},
): Promise<NativeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject); // spawn failure (ENOENT) is a real error
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/util/native.test.ts` → Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/util/native.ts src/util/native.test.ts
git commit -m "feat(util): native subprocess runner (no-throw on non-zero exit)"
```

---

## Task 2: `util/glob` — glob matcher parity

**Files:** Create `src/util/glob.ts`, `src/util/glob.test.ts`

Parity: `_common.ps1` `Test-GlobMatch` — `**` matches across `/`; `*` matches within a path segment only (not across `/`); case-sensitive; forward-slash normalized.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { globMatch } from "./glob.js";

describe("globMatch", () => {
  it("* matches within a segment, not across slashes", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/sub/a.ts")).toBe(false);
  });
  it("** matches across slashes", () => {
    expect(globMatch("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/sub/deep/a.ts")).toBe(true);
  });
  it("normalizes backslashes to forward slashes", () => {
    expect(globMatch("src/*.ts", "src\\a.ts")).toBe(true);
  });
  it("matches a bare filename glob anywhere via **", () => {
    expect(globMatch("**/*-policy.md", "docs/x-policy.md")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail** — Run: `npx vitest run src/util/glob.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `src/util/glob.ts`**

```ts
/**
 * Glob matcher with parity to the PS `Test-GlobMatch`:
 *  - paths normalized to forward slashes
 *  - `**` matches any number of characters INCLUDING `/`
 *  - `*`  matches any characters EXCEPT `/` (within one path segment)
 *  - `?`  matches a single non-`/` character
 * Case-sensitive. Anchored (must match the whole path).
 */
export function globMatch(pattern: string, path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const re = globToRegExp(pattern.replace(/\\/g, "/"));
  return re.test(p);
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` (optionally followed by `/`) → match across segments
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?"; // zero-or-more full segments
        // fall-through case: a trailing ** matches everything
        if (i >= glob.length) re += ".*";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re);
}
```

Note: if the `**/*.ts` case fails because `(?:.*/)?` consumed the slash before `*`, adjust `globToRegExp` so `**/` → `(?:.*/)?` and a following `*` still yields `[^/]*` (the tests are the spec — make them pass, keeping `*` segment-local and `**` cross-segment).

- [ ] **Step 4: Run to verify pass** → Expected: 4 passed. Fix regex until green.

- [ ] **Step 5: Commit**

```bash
git add src/util/glob.ts src/util/glob.test.ts
git commit -m "feat(util): glob matcher with **/* segment semantics (Test-GlobMatch parity)"
```

---

## Task 3: `config` — load & validate per-project config

**Files:** Create `src/config/schema.ts`, `src/config/config.ts`, `src/config/config.test.ts`

Parity anchors: `Get-AutodevConfig` (`_common.ps1:41-92`), knob defaults (parity spec §9), the 10 couplings → config keys (design spec §5, parity spec §10). Repo-root discovery generalized from `Get-AutodevRepoRoot` (coupling #1): configurable markers, default `.git`.

- [ ] **Step 1: Write `src/config/schema.ts` (zod schema with defaults from §9)**

```ts
import { z } from "zod";

export const HarnessConfigSchema = z.object({
  stateDir: z.string().default(".autodev"),
  allowedBranchPattern: z.string().default("^autodev/"),

  repoRoot: z
    .object({ markers: z.array(z.string()).default([".git"]) })
    .default({ markers: [".git"] }),

  gate: z
    .object({
      checkCommand: z.string().nullable().default(null), // e.g. "composer check" / "npm test"
      skipCheckByDefault: z.boolean().default(false),
    })
    .default({ checkCommand: null, skipCheckByDefault: false }),

  guards: z
    .object({ testCommandTemplate: z.string().default("{testFile}") }) // {testFile} placeholder
    .default({ testCommandTemplate: "{testFile}" }),

  antiDrift: z
    .object({
      intentSource: z.string().nullable().default(null),
      headers: z.array(z.string()).default([]), // empty = feed whole file
      everyCommits: z.number().int().positive().default(5),
      model: z.string().default("sonnet"),
    })
    .default({ intentSource: null, headers: [], everyCommits: 5, model: "sonnet" }),

  contract: z
    .object({
      constitutionPaths: z.array(z.string()).default([]),
      invariantsFile: z.string().default("INVARIANTS.md"),
      guardsFile: z.string().default("GUARDS.md"),
    })
    .default({ constitutionPaths: [], invariantsFile: "INVARIANTS.md", guardsFile: "GUARDS.md" }),

  worker: z
    .object({
      ladder: z.array(z.string()).default(["opus", "sonnet", "haiku"]),
      promptHints: z.array(z.string()).default([]),
      exe: z.string().default("claude"),
      maxTurns: z.number().int().positive().default(100),
      timeoutMinutes: z.number().positive().default(20),
      staleMinutes: z.number().positive().default(15),
    })
    .default({}),

  critic: z
    .object({
      exe: z.string().default("codex"),
      model: z.string().default("gpt-5.5"),
      effort: z.string().default("high"),
      retryMax: z.number().int().nonnegative().default(1),
    })
    .default({}),

  commit: z
    .object({ typeMap: z.record(z.string()).default({ guard: "test" }), defaultKind: z.string().default("refactor") })
    .default({ typeMap: { guard: "test" }, defaultKind: "refactor" }),

  loop: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      sleepSeconds: z.number().positive().default(30),
      rateLimitBackoffSeconds: z.number().positive().default(600),
      maxSessionHours: z.number().positive().default(8),
    })
    .default({}),

  dirtyFenceIgnore: z
    .array(z.string())
    .default([
      ".autodev/runtime/",
      ".autodev/queue/",
      ".autodev/escalations/",
      ".autodev/conductor.log",
      ".autodev/digest.md",
    ]),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
```

- [ ] **Step 2: Write the failing test `src/config/config.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "adh-cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
  it("applies documented defaults when the file omits keys", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "gate:\n  checkCommand: npm test\n");
    const cfg = await loadConfig(dir);
    expect(cfg.loop.maxAttempts).toBe(3);
    expect(cfg.worker.ladder).toEqual(["opus", "sonnet", "haiku"]);
    expect(cfg.gate.checkCommand).toBe("npm test");
    expect(cfg.allowedBranchPattern).toBe("^autodev/");
  });

  it("throws a clear error on an invalid type", async () => {
    mkdirSync(join(dir, ".autodev"), { recursive: true });
    writeFileSync(join(dir, ".autodev", "config.yaml"), "loop:\n  maxAttempts: not-a-number\n");
    await expect(loadConfig(dir)).rejects.toThrow(/maxAttempts/);
  });

  it("falls back to all-defaults when no config file exists", async () => {
    const cfg = await loadConfig(dir);
    expect(cfg.stateDir).toBe(".autodev");
  });
});
```

- [ ] **Step 3: Run to verify fail** → FAIL (no module).

- [ ] **Step 4: Implement `src/config/config.ts`**

```ts
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

/** Load `<repoRoot>/.autodev/config.yaml`, validate against the schema, apply defaults. */
export async function loadConfig(repoRoot: string): Promise<HarnessConfig> {
  const path = join(repoRoot, ".autodev", "config.yaml");
  let raw: unknown = {};
  if (existsSync(path)) {
    raw = parseYaml(await readFile(path, "utf8")) ?? {};
  }
  const parsed = HarnessConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid .autodev/config.yaml: ${issues}`);
  }
  return parsed.data;
}
```

- [ ] **Step 5: Run to verify pass** → Expected: 3 passed.

- [ ] **Step 6: Add repo-root detection test + impl (coupling #1 generalization)**

Add to `config.test.ts`:
```ts
import { detectRepoRoot } from "./config.js";
it("detectRepoRoot walks up to the nearest marker dir", () => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  const nested = join(dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  expect(detectRepoRoot(nested, [".git"])).toBe(dir);
});
```
Add to `config.ts`:
```ts
import { dirname } from "node:path";
export function detectRepoRoot(start: string, markers: string[] = [".git"]): string {
  let cur = start;
  for (;;) {
    if (markers.some((m) => existsSync(join(cur, m)))) return cur;
    const parent = dirname(cur);
    if (parent === cur) throw new Error(`repo root not found from ${start} (markers: ${markers.join(", ")})`);
    cur = parent;
  }
}
```

- [ ] **Step 7: Run all config tests** → Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
git add src/config/
git commit -m "feat(config): load+validate .autodev/config.yaml with §9 defaults; repo-root detect"
```

---

## Task 4: `blackboard/task` — task frontmatter parser

**Files:** Create `src/blackboard/types.ts`, `src/blackboard/task.ts`, `src/blackboard/task.test.ts`

Parity: `ConvertFrom-AutodevTask` (`_common.ps1:351-410`) + real fields (parity spec §3). Pre-initialized StrictMode-safe defaults; `depends_on` tolerant of block-list/inline/absent forms.

- [ ] **Step 1: Write `src/blackboard/types.ts`**

```ts
export interface Task {
  id: string;
  title: string;
  type: string;
  touches_contract_zone: boolean;
  writes_guard: boolean;
  model: string | null;
  success_commands: string[];
  forbidden_paths: string[];
  max_rounds: number | null;
  file_set: string[];
  depends_on: string[];
  contract_zones_touched: string[];
  needs_guard: boolean;
  acceptance: string[];
  phase?: string;
  body: string;
  path: string;
}
```

- [ ] **Step 2: Write the failing test `src/blackboard/task.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseTask } from "./task.js";

const SAMPLE = `---
id: s7-t1-model-tiering
title: Wire per-task model tiering
type: tooling
touches_contract_zone: false
file_set:
  - src/a.ts
  - src/b.ts
depends_on: []
needs_guard: no
acceptance:
  - "supports optional model field"
---
# Task
Do the thing.
`;

describe("parseTask", () => {
  it("parses scalars, lists, and body", () => {
    const t = parseTask(SAMPLE, "queue/pending/s7-t1.md");
    expect(t.id).toBe("s7-t1-model-tiering");
    expect(t.type).toBe("tooling");
    expect(t.file_set).toEqual(["src/a.ts", "src/b.ts"]);
    expect(t.needs_guard).toBe(false);
    expect(t.body.trim().startsWith("# Task")).toBe(true);
    expect(t.path).toBe("queue/pending/s7-t1.md");
  });

  it("applies StrictMode-safe defaults for omitted keys", () => {
    const t = parseTask("---\nid: x\ntitle: y\ntype: z\n---\nbody", "p");
    expect(t.touches_contract_zone).toBe(false);
    expect(t.model).toBeNull();
    expect(t.success_commands).toEqual([]);
    expect(t.file_set).toEqual([]);
    expect(t.max_rounds).toBeNull();
  });

  it("coerces yes/no to booleans (needs_guard, writes_guard)", () => {
    const t = parseTask("---\nid: x\ntitle: y\ntype: z\nwrites_guard: yes\nneeds_guard: no\n---\n", "p");
    expect(t.writes_guard).toBe(true);
    expect(t.needs_guard).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify fail** → FAIL (no module).

- [ ] **Step 4: Implement `src/blackboard/task.ts`**

```ts
import { parse as parseYaml } from "yaml";
import type { Task } from "./types.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function toBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(yes|true)$/i.test(v.trim());
  return fallback;
}
function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null || v === "") return [];
  return [String(v)];
}

/** Parse a blackboard task file (frontmatter + markdown body) into a Task. */
export function parseTask(content: string, path: string): Task {
  const m = FRONTMATTER.exec(content);
  const fmText = m ? m[1]! : "";
  const body = m ? m[2]! : content;
  const fm = (fmText ? parseYaml(fmText) : {}) ?? {};

  return {
    id: String(fm.id ?? ""),
    title: String(fm.title ?? ""),
    type: String(fm.type ?? ""),
    touches_contract_zone: toBool(fm.touches_contract_zone),
    writes_guard: toBool(fm.writes_guard),
    model: fm.model != null ? String(fm.model) : null,
    success_commands: toStrArray(fm.success_commands),
    forbidden_paths: toStrArray(fm.forbidden_paths),
    max_rounds: fm.max_rounds != null ? Number(fm.max_rounds) : null,
    file_set: toStrArray(fm.file_set),
    depends_on: toStrArray(fm.depends_on),
    contract_zones_touched: toStrArray(fm.contract_zones_touched),
    needs_guard: toBool(fm.needs_guard),
    acceptance: toStrArray(fm.acceptance),
    ...(fm.phase != null ? { phase: String(fm.phase) } : {}),
    body,
    path,
  };
}
```

- [ ] **Step 5: Run to verify pass** → Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/blackboard/types.ts src/blackboard/task.ts src/blackboard/task.test.ts
git commit -m "feat(blackboard): task frontmatter parser (ConvertFrom-AutodevTask parity)"
```

---

## Task 5: `blackboard` repository — interface + file impl

**Files:** Create `src/blackboard/repository.ts`, `src/blackboard/file-repository.ts`, `src/blackboard/file-repository.test.ts`

Parity: `.autodev/` layout (parity spec §3), queue states `pending|active|done|escalated|quarantine`, `runtime/<id>/`, `digest.md`. This is the state seam — every state read/write goes through the interface.

- [ ] **Step 1: Write `src/blackboard/repository.ts` (the seam)**

```ts
import type { Task } from "./types.js";

export type QueueState = "pending" | "active" | "done" | "escalated" | "quarantine";

export interface BlackboardRepository {
  listTasks(state: QueueState): Promise<Task[]>;
  moveTask(id: string, from: QueueState, to: QueueState): Promise<void>;
  getAttempts(id: string): Promise<number>;
  setAttempts(id: string, n: number): Promise<void>;
  writeRuntimeFile(id: string, name: string, content: string): Promise<void>;
  readRuntimeFile(id: string, name: string): Promise<string | null>;
  markDone(id: string, commitHash: string): Promise<void>; // append `<!-- committed: hash -->`
  appendDigest(line: string): Promise<void>;
  runtimeDir(id: string): string;
}
```

- [ ] **Step 2: Write the failing test `src/blackboard/file-repository.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlackboardRepository } from "./file-repository.js";

let root: string;
let repo: FileBlackboardRepository;
function seedPending(id: string): void {
  const p = join(root, ".autodev", "queue", "pending");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, `${id}.md`), `---\nid: ${id}\ntitle: t\ntype: tooling\nfile_set:\n  - src/x.ts\n---\nbody`);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "adh-bb-"));
  repo = new FileBlackboardRepository(root, ".autodev");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("FileBlackboardRepository", () => {
  it("lists pending tasks parsed from files", async () => {
    seedPending("t1");
    const tasks = await repo.listTasks("pending");
    expect(tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(tasks[0]!.file_set).toEqual(["src/x.ts"]);
  });

  it("moves a task atomically between queue states", async () => {
    seedPending("t1");
    await repo.moveTask("t1", "pending", "active");
    expect(existsSync(join(root, ".autodev", "queue", "pending", "t1.md"))).toBe(false);
    expect(existsSync(join(root, ".autodev", "queue", "active", "t1.md"))).toBe(true);
  });

  it("round-trips attempts counter", async () => {
    expect(await repo.getAttempts("t1")).toBe(0);
    await repo.setAttempts("t1", 2);
    expect(await repo.getAttempts("t1")).toBe(2);
  });

  it("markDone appends the committed marker to the done file", async () => {
    seedPending("t1");
    await repo.moveTask("t1", "pending", "done");
    await repo.markDone("t1", "abc1234");
    const txt = readFileSync(join(root, ".autodev", "queue", "done", "t1.md"), "utf8");
    expect(txt).toContain("<!-- committed: abc1234 -->");
  });

  it("appendDigest adds a line to digest.md", async () => {
    await repo.appendDigest("[anti-drift] ON-TRACK: fine");
    const txt = readFileSync(join(root, ".autodev", "digest.md"), "utf8");
    expect(txt).toContain("ON-TRACK: fine");
  });
});
```

- [ ] **Step 3: Run to verify fail** → FAIL (no module).

- [ ] **Step 4: Implement `src/blackboard/file-repository.ts`**

```ts
import { readFile, writeFile, rename, mkdir, readdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseTask } from "./task.js";
import type { Task } from "./types.js";
import type { BlackboardRepository, QueueState } from "./repository.js";

export class FileBlackboardRepository implements BlackboardRepository {
  constructor(private readonly repoRoot: string, private readonly stateDir: string) {}

  private queueDir(state: QueueState): string {
    return join(this.repoRoot, this.stateDir, "queue", state);
  }
  runtimeDir(id: string): string {
    return join(this.repoRoot, this.stateDir, "runtime", id);
  }

  async listTasks(state: QueueState): Promise<Task[]> {
    const dir = this.queueDir(state);
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    const tasks: Task[] = [];
    for (const f of files) {
      const rel = join("queue", state, f);
      tasks.push(parseTask(await readFile(join(dir, f), "utf8"), rel));
    }
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  }

  async moveTask(id: string, from: QueueState, to: QueueState): Promise<void> {
    const src = join(this.queueDir(from), `${id}.md`);
    const dstDir = this.queueDir(to);
    await mkdir(dstDir, { recursive: true });
    await rename(src, join(dstDir, `${id}.md`)); // atomic within a filesystem
  }

  async getAttempts(id: string): Promise<number> {
    const p = join(this.runtimeDir(id), "attempts");
    if (!existsSync(p)) return 0;
    return Number((await readFile(p, "utf8")).trim()) || 0;
  }
  async setAttempts(id: string, n: number): Promise<void> {
    await mkdir(this.runtimeDir(id), { recursive: true });
    await writeFile(join(this.runtimeDir(id), "attempts"), String(n));
  }

  async writeRuntimeFile(id: string, name: string, content: string): Promise<void> {
    await mkdir(this.runtimeDir(id), { recursive: true });
    await writeFile(join(this.runtimeDir(id), name), content);
  }
  async readRuntimeFile(id: string, name: string): Promise<string | null> {
    const p = join(this.runtimeDir(id), name);
    return existsSync(p) ? readFile(p, "utf8") : null;
  }

  async markDone(id: string, commitHash: string): Promise<void> {
    const p = join(this.queueDir("done"), `${id}.md`);
    await appendFile(p, `\n<!-- committed: ${commitHash} -->\n`);
  }

  async appendDigest(line: string): Promise<void> {
    const p = join(this.repoRoot, this.stateDir, "digest.md");
    await mkdir(join(this.repoRoot, this.stateDir), { recursive: true });
    await appendFile(p, `${line}\n`);
  }
}
```

- [ ] **Step 5: Run to verify pass** → Expected: 5 passed.

- [ ] **Step 6: Run codex review on config + blackboard, then commit**

```bash
git add src/blackboard/repository.ts src/blackboard/file-repository.ts src/blackboard/file-repository.test.ts
git commit -m "feat(blackboard): file repository over .autodev/ layout (state seam)"
```

---

## Task 6: `util/git` — git CLI helpers

**Files:** Create `src/util/git.ts`, `src/util/git.test.ts`

Interface (each shells `git` via `runNative`, resolves parity behaviors):
```ts
export interface Git {
  currentBranch(): Promise<string>;                       // rev-parse --abbrev-ref HEAD
  changedFiles(scope?: string[]): Promise<string[]>;      // status/diff --name-only vs HEAD
  diffText(scope?: string[]): Promise<string>;            // diff (optionally scoped to paths)
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<string>;               // returns commit hash
  worktreeAdd(path: string, branch: string, base: string): Promise<void>;
  worktreeRemove(path: string): Promise<void>;
  merge(branch: string): Promise<{ ok: boolean; conflict: boolean }>;
}
export function createGit(repoRoot: string): Git;
```
Key tests (use a real temp git repo initialized in `beforeEach` via `git init`): `currentBranch` after checkout; `diffText` scoped to a path excludes other files; `commit` returns a hash; `worktreeAdd`/`worktreeRemove` create/clean a linked worktree; `merge` reports conflict=true on a conflicting merge. Parity: scoped diff = `Get-GitFileSetDiffText` (`_common.ps1:491-507`, divergence #7).

Commit: `feat(util): git CLI helpers (scoped diff, worktree, merge-conflict detection)`

---

## Task 7: `worktree` — per-task worktree lifecycle

**Files:** Create `src/worktree/worktree.ts`, `src/worktree/worktree.test.ts`

This is a **deliberate divergence from the PS loop** (parity spec divergence #1: PS uses ONE shared tree + file_set lock; we adopt the AO per-task worktree pattern, frozen skeleton axis 4). Non-destructive teardown; gate runs on worktree diff; conductor merges after gate.

Interface:
```ts
export interface Worktree { path: string; branch: string; taskId: string; }
export interface WorktreeManager {
  create(taskId: string, baseBranch: string): Promise<Worktree>;   // branch autodev/wt-<id> off base
  diff(wt: Worktree, scope?: string[]): Promise<string>;
  teardown(wt: Worktree): Promise<void>;                            // remove worktree, keep branch
  mergeAfterGate(wt: Worktree, intoBranch: string): Promise<{ ok: boolean; conflict: boolean }>;
}
```
Key tests: `create` yields an isolated working dir on a new branch; edits there don't touch the main tree; `mergeAfterGate` fast-forwards/merges the branch into the loop branch; conflict → `{ok:false, conflict:true}` (fail-closed → conductor escalates, parity spec §7); `teardown` removes the worktree dir but the branch/commits survive (non-destructive).

Commit: `feat(worktree): per-task git worktree lifecycle (AO isolation pattern)`

---

## Task 8: `router` — model ladder resolution

**Files:** Create `src/router/router.ts`, `src/router/router.test.ts`

Parity: worker ladder construction (parity spec §6 lines 463-471, §7). **Contract-zone pin wins unconditionally** → `[ladder[0]]` (opus); else declared `model:` in ladder → sub-ladder from that index (cheaper-only); else declared-but-unknown → WARN + full ladder; else full ladder.

Interface:
```ts
export interface Router { resolveLadder(task: Task): { ladder: string[]; warnings: string[] }; }
export function createRouter(cfg: HarnessConfig): Router;
```
Key tests (table-driven, from §7):
- `touches_contract_zone:true` + `model:haiku` → `["opus"]` + warning about the downgrade.
- `model:sonnet` (non-contract) → `["sonnet","haiku"]`.
- `model:haiku` → `["haiku"]`.
- no `model:` → `["opus","sonnet","haiku"]`.
- `model:bogus` → full ladder + warning.

Commit: `feat(router): model ladder resolution (contract pin + cheaper sub-ladder)`

---

## Task 9–11: `worker` adapter (claude)

**Files:** `src/worker/adapter.ts`, `src/worker/prompt.ts`, `src/worker/claude-adapter.ts`, `+ *.test.ts`

Parity: `invoke-worker.ps1` (§6). The **watchdog** (Task 20) must exist first OR be stubbed behind an injected interface; prefer building Task 20 before Task 11's real spawn.

Interfaces:
```ts
export type WorkerStatus = "DONE" | "TOO_BIG" | "NEEDS_GUARD" | "BLOCKED" | "RATE_LIMITED" | "TIMED_OUT";
export interface WorkerResult { status: WorkerStatus; model: string; rateLimited: boolean; timedOut: boolean; exitCode: number; }
export interface WorkerAdapter {
  run(input: {
    task: Task; worktreePath: string; ladder: string[];
    criticFeedback?: string; runtimeDir: string;
  }): Promise<WorkerResult>;
}
```
- **Task 9 — `prompt.ts`:** `buildWorkerPrompt(task, cfg, criticFeedback?)` → string. Tests: includes task body; includes rules block (touch only file_set, never forbidden_paths, smallest change, TOO_BIG/NEEDS_GUARD stop conditions, do NOT git commit/add except `git add -N`, do NOT run gate, touch heartbeat); includes critic feedback only on retry; includes `cfg.worker.promptHints`. Parity: `Build-WorkerPrompt` (§6 lines 483-489).
- **Task 10 — `adapter.ts` + a fake adapter** for unit tests (no real LLM). Contract test: given a fake that writes a `worker-report.md` with `status: DONE`, the adapter surfaces `DONE`.
- **Task 11 — `claude-adapter.ts`:** builds `claude -p --model <m> --permission-mode acceptEdits --max-turns <n> --verbose --output-format stream-json`, runs each ladder step through the watchdog. Rate-limit handling per step (§6 lines 490-495): contract-zone + rateLimited → return `RATE_LIMITED` (pause, no downgrade); non-contract + rateLimited → `continue` to next cheaper step; timedOut → `TIMED_OUT` break; else `DONE` break. Conductor reads `worker-report.md` for authoritative status (adapter returns transport status). One integration test behind an env flag (`ADH_LIVE=1`) that really spawns `claude -p`.

Commits: one per task (`feat(worker): …`).

---

## Task 12–14: `critic` adapter (codex) + fencing

**Files:** `src/critic/adapter.ts`, `src/critic/verdict.ts`, `src/critic/codex-adapter.ts`, `+ *.test.ts`

Parity: `invoke-critic.ps1` (§5). **Fencing is load-bearing** — physically move `worker-report.md` out of the repo tree for the call, restore in `finally`.

Interfaces:
```ts
export interface Verdict { verdict: "clean" | "broken" | "uncertain"; broken_contracts: BrokenContract[]; notes: string; confidence: number; diff_sha256?: string; }
export interface CriticResult { verdict: Verdict | null; rateLimited: boolean; }
export interface CriticAdapter { run(input: { diff: string; runtimeDir: string; workerReportPath: string | null; }): Promise<CriticResult>; }
```
- **Task 12 — `verdict.ts`:** zod schema (`additionalProperties:false`, all 4 fields required); `parseVerdict(text)` tolerant regex `(?s)\{.*\}` extraction; add `diff_sha256`. Tests: parse a clean verdict; parse when wrapped in surrounding text; reject a verdict missing `confidence`. Parity spec §3 verdict.json + §5 parsing (a parsed verdict wins over rate-limit heuristics — the 2026-06-07 fix).
- **Task 13 — fencing helper:** `withWorkerReportFenced(path, fn)` — move file out, run `fn`, restore in `finally` even on throw. Test: file is absent during `fn`, present after (even if `fn` throws).
- **Task 14 — `codex-adapter.ts`:** empty diff → `none` tier (synthetic clean verdict, confidence 0.5); else spawn `codex exec -m <model> -c model_reasoning_effort="<effort>" -c approval_policy="never" -s read-only -C <root> --skip-git-repo-check --output-schema <schema> -o <outfile> -` with the adversarial prompt piped on stdin (diff embedded inline). Rate-limit (exit 4) reachable ONLY when no verdict parsed. Ship `critic-verdict.schema.json`. Integration test behind `ADH_LIVE=1`.

Commits: `feat(critic): …` each.

---

## Task 15–19: `gate` + `guards` + `mutation-check`

**Files:** `src/gate/invariants.ts`, `src/gate/guards.ts`, `src/gate/mutation-check.ts`, `src/gate/gate.ts`, `+ *.test.ts`

Parity: `gate.ps1` (§4) — the machine lock. **Per-VALUE coverage** (divergence #2) is the subtle correctness core.

- **Task 15 — `invariants.ts`:** parse the `<!-- BEGIN/END MACHINE-INVARIANTS -->` fenced JSON (parity spec §3 INVARIANTS block); `zoneTouched(zone, diff)` = path_glob OR grep_pattern OR exact_string; `zoneTouchedStrings(zone, diff)` = which `exact_strings` appear in +/- diff lines. Tests from real schema.
- **Task 16 — `guards.ts`:** parse the 7-column `GUARDS.md` pipe table; `selectGuardForValue(canonicalValue)` (recipe.canonical_value EXACT match); `selectGuardForZone(zoneId)` (fallback); `isBlessed(guard)` (`blessed_by` not empty/`pending-operator`). Tests: sibling value NOT auto-covered (divergence #2 / gate self-test case 2).
- **Task 17 — `mutation-check.ts`:** given a recipe `{file, locator, canonical_value, mutated_value, guard_test}` + `cfg.guards.testCommandTemplate`: snapshot bytes → run guard (GREEN) → literal-substring replace canonical→mutated → run guard (must go RED) → restore (finally) → run guard (GREEN). Returns pass/fail. Test with a fake test command that greps for a string.
- **Task 18 — `gate.ts` decision core:** checks in order (§4 step 6): empty file_set → fixed ESCALATE (before loading INVARIANTS); scope resolution; `checkCommand` whole-tree; each `success_commands`; constitution touched → ESCALATE; per-zone coverage (per-value → all covered+blessed+still-RED else ESCALATE); decision `RETRY if !checkGreen||!successGreen` (first) else ESCALATE if constitution else ESCALATE if any zone bad else COMMIT. Emit `gate-verdict.json` (parity spec §3 shape).
- **Task 19 — gate self-tests port:** the 5 `gate.ps1 -SelfTest` cases, especially case 2 (sibling-value uncovered).

Commits: `feat(gate): …` each. Run codex review on the whole gate group (highest-risk correctness).

---

## Task 20–23: `watchdog` + `escalate` + `anti-drift`

- **Task 20 — `watchdog.ts`** (`src/watchdog/watchdog.ts`): `runWatched({command,args,stdin,heartbeatPath,activityPaths,staleSeconds,timeoutSeconds})` → `{exitCode,timedOut,rateLimited,stdout,stderr}`. Liveness = newest of (stream activity on every line, heartbeat mtime, mtime under activityPaths). Kill whole process tree on staleness or hard timeout. Cross-platform tree-kill (Win: `taskkill /T`; POSIX: process-group kill) — divergence from the WMI-specific PS impl. Tests: a process that stalls past staleSeconds is killed; a process emitting lines stays alive; hard timeout fires. Parity: `watchdog.ps1` (§1, §6).
- **Task 21 — `escalate.ts`** (`src/escalate/escalate.ts`): write `escalations/<id>.md` (fixed template, §3/§8); type enum `needs-guard|disagreement|constitution|uncertain|poison|blocked|dirty-file|drift`; delivery: if `AUTODEV_TELEGRAM_TOKEN`+`AUTODEV_TELEGRAM_CHAT` env set → POST to Telegram; else append checkbox line to `escalations/_outbox.md`. Move-task-before-write ordering is the conductor's responsibility (§8), not escalate's. Tests: artifact written with all fields; outbox line appended when env unset; write failure never throws.
- **Task 22 — `anti-drift.ts`** (`src/anti-drift/anti-drift.ts`): read intent (whole file if no headers, else regex-extract configured headers — coupling #4); `git diff <sinceRef>..HEAD`; call fixed sonnet critic; append exactly one `[ts] [anti-drift] (window: N) ON-TRACK:|DRIFT:|UNCERTAIN: <sentence>` to digest; unparseable → UNCERTAIN (never false ON-TRACK). Test with a fake model runner.
- **Task 23 — fingerprint dirty-file fence** (`src/util/fingerprint.ts`): SHA256 content fingerprints of changed paths (divergence #3 — content-keyed, not path-set). `snapshot()`, `workerTouched(baseline, now)` = new-or-changed fingerprints; `strayChanged(touched, fileSet, ignore)`; `forbiddenTouches(touched, forbiddenPaths)`. Tests incl. the "already-dirty out-of-scope file still caught" case (conductor self-test case 8).

Commits: `feat(watchdog|escalate|anti-drift|util): …`.

---

## Task 24–26: `conductor` — the loop

**Files:** `src/conductor/conductor.ts`, `src/conductor/conductor.test.ts`

Parity: `conductor.ps1` (§2) — the exact step sequence. This is pure wiring + judgment routing; zero LLM calls. Compose axes 3+4 (design spec §4).

- **Task 24 — preflight + iteration spine:** branch preflight (refuse unless HEAD matches `allowedBranchPattern`, never main); `Invoke-ConductorIteration`: CLAIM → CIRCUIT BREAKER (`attempts+1`, `>maxAttempts` → quarantine+escalate poison) → worker → report routing (TOO_BIG→quarantine+blocked; NEEDS_GUARD→escalated; BLOCKED→escalated) → dirty-file fence (worktree adaptation) → diff+critic (bounded retry; rate-limit refund on BOTH worker and critic — divergence #8; contract-risk never auto-retries) → gate → decision (RETRY→pending not active, divergence #4; COMMIT re-checks branch at commit time, divergence #10, merge worktree, markDone, append digest; else fail-closed escalate).
- **Task 25 — outer loop:** `maxSessionHours` graceful exit checked at top (divergence #9); anti-drift every N commits via explicit `iterationCommitted` flag (not done/ existence); sleep = rateLimitBackoff if 429 (explicit `iterationRateLimited` flag) else sleepSeconds if idle; `--once`/`--maxIterations`.
- **Task 26 — port the conductor self-tests (8 cases):** circuit-breaker refund invariant, fail-closed commit gating, counter-increment guard, branch preflight, dirty-file fence (constitution-catch + boundary + fingerprint), drift-escalation routing. These are pure (no subprocess) — implement with fakes for worker/critic/gate.

Use dependency injection: conductor takes `{repo, scheduler, worktree, worker, critic, gate, escalate, router, git, clock, log}` so tests inject fakes. Commit each task.

---

## Task 27: thin `api` (P2 seam)

**Files:** `src/api/server.ts`, `src/api/server.test.ts`

Thin `http` + `ws` over `BlackboardRepository`: `GET /state` (all queues + digest tail); WS stream of changes via `chokidar` watching `.autodev/`; `POST /escalations/:id/reply` accepting a structured A/B reply (free text recorded for context, never fed to a worker — injection surface, §8). Tests: `/state` returns seeded queues; a file change pushes a WS message. Commit: `feat(api): thin read + change-stream + escalation-reply server`.

---

## Task 28–29: parity harness + CI

- **Task 28 — parity harness** (`test/parity/…`): a fixture repo with seeded tasks (a normal task, a contract-zone task, a TOO_BIG, a poison, a 429 simulation via fake adapters). Run the TS loop and assert the same COMMIT/ESCALATE/RETRY decisions and the same `done/`+`escalations/` end-state the PS loop produces for equivalent inputs. This is the **P1 Definition of Done** on the fixture side. Live woodev-workload parity is a separate operator-gated step.
- **Task 29 — CI** (`.github/workflows/ci.yml`): matrix `os: [ubuntu-latest, windows-latest]` (+ macOS best-effort), `node: [20, 22]`; steps `npm ci`, `npm run typecheck`, `npm test`. Proves the PowerShell Windows-lock is gone.

Commits: `test(parity): …`, `ci: cross-platform matrix (win+linux)`.

---

## Spec-coverage self-check (plan ↔ design spec §§)

| Design/parity spec section | Task(s) |
|---|---|
| §5 config / 10 couplings; §9 knobs | Task 3 |
| §3 blackboard schema (task, report, verdict, gate, escalation, digest) | Tasks 4, 5, 12, 18, 21, 22 |
| Axis 4 isolation / worktree (divergence #1) | Tasks 6, 7 |
| §7 model routing | Task 8 |
| §6 worker + watchdog liveness | Tasks 9–11, 20 |
| §5 critic + fencing | Tasks 12–14 |
| §4 gate, per-value coverage (divergence #2), mutation-check | Tasks 15–19 |
| §8 escalation + delivery | Task 21 |
| anti-drift (coupling #4) | Task 22 |
| dirty-file fence content-fingerprint (divergence #3) | Task 23 |
| §2 conductor loop + divergences #4,#8,#9,#10 | Tasks 24–26 |
| P2 API seam | Task 27 |
| §8 testing strategy / parity DoD / cross-platform | Tasks 28–29 |

Every seam (WorkerAdapter, CriticAdapter, GateExtension, Checkpoint, BlackboardRepository, Router — design spec §6) is a named interface introduced in its task.

---

## Related
- `../specs/2026-07-01-harness-p1-core-loop-design.md` — the design this plan implements.
- `../donor-extraction/autodev-loop-parity-spec.md` — the AS-BUILT behavioral oracle.
- `../donor-extraction/decision-matrix.md` — the verified basis for the frozen skeleton.
