# Onboarding Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator register ANY folder as a project (not only existing git repos), auto-`git init` + put it on an `^autodev/` branch when needed, and warn when git is not installed — from the existing in-browser folder browser.

**Architecture:** Backend-first, module-by-module. New `Git` verbs + a shared `ensureAutodevBranch`/`initAutodevRepo` helper (which also delivers the s30 Task 1 branch-guard fix at register + defensive daemon startup), folder-browser hidden-dir filtering, a git PATH probe, two new admin endpoints (`POST /fs/git-init`, `GET /system/git`), then review-only UI. Every backend module goes through TDD → typecheck → `npm test` → **codex GPT-5.5 critic gate**; UI is review-only.

**Tech Stack:** Node LTS + TypeScript (ESM `.js` imports, strict NodeNext, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, React + Vite + TanStack Query/Router, shadcn/Base UI. Worker = Sonnet 5; critic = codex GPT-5.5.

**Spec:** `docs/superpowers/specs/2026-07-07-onboarding-redesign-design.md`

---

## File structure

| File | Responsibility | Status |
|---|---|---|
| `src/util/git.ts` | +`init`/`listBranches`/`checkoutBranch`/`createBranch`/`commitEmpty`/`countUntracked` on the `Git` seam | modify |
| `src/util/ensure-branch.ts` | `ensureAutodevBranch(git)` + `initAutodevRepo(git)` — the shared branch/bootstrap ops (s30 Task 1) | create |
| `src/fsbrowse/fsbrowse.ts` | hide system/hidden dirs in `listDirs` | modify |
| `src/detect/detect-agents.ts` | export the 4 PATH-probe helpers so `detect-git` can reuse them (no behavior change) | modify |
| `src/detect/detect-git.ts` | `detectGit()` — is `git` on PATH + best-effort version | create |
| `src/registry/admin.ts` | drop the `not_a_git_repo` gate; +`initGit`; ensure-branch in `register`; inject `gitOps` | modify |
| `src/api/server.ts` | `POST /fs/git-init`, `GET /system/git` handlers + `admin.initGit`/`admin.detectGit` deps + routes | modify |
| `src/index.ts` | wire `admin.initGit`/`detectGit`; defensive startup ensure-branch over registered projects | modify |
| `ui/src/lib/api.ts` + `queries.ts` | `getSystemGit`/`gitInit` clients + `useSystemGit`/`useGitInit` hooks + types | modify |
| `ui/src/components/FolderBrowser.tsx` | any-folder select + inline "init git" | modify |
| `ui/src/views/NewProjectView.tsx` | git-not-installed banner + "Install it now" + untracked hint | modify |

Backend modules (Tasks 1–7) form ONE codex-gated batch (they don't function partially: the endpoints need the helpers). Gate after Task 7. UI (Tasks 8–10) is review-only. Task 11 = integration verify + docs + merge.

**Branch:** create `autodev/s30-onboarding-redesign` off `main` before Task 1.

---

## Task 1: `Git` seam — new verbs

**Files:**
- Modify: `src/util/git.ts` (interface `Git` at :8; `createGit` return object at :29)
- Test: `src/util/git.test.ts` (real-temp-repo harness at :11-42)

- [ ] **Step 1: Write the failing tests** — append inside the `describe("createGit", …)` block in `src/util/git.test.ts`:

```typescript
  it("init creates a repo in an empty dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adh-init-"));
    try {
      const g = createGit(dir);
      await g.init();
      expect(existsSync(join(dir, ".git"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commitEmpty establishes HEAD even with no configured user (baked identity)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adh-empty-"));
    try {
      const g = createGit(dir);
      await g.init();
      const sha = await g.commitEmpty("chore: initialize autodev project");
      expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
      // No user.email/user.name configured in this repo — commit must still succeed.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listBranches lists local branches; createBranch + checkoutBranch switch", async () => {
    // Harness repo starts on `main` with one commit.
    await git.createBranch("autodev/main");
    expect(await git.currentBranch()).toBe("autodev/main");
    const branches = await git.listBranches();
    expect(branches).toEqual(expect.arrayContaining(["main", "autodev/main"]));
    await git.checkoutBranch("main");
    expect(await git.currentBranch()).toBe("main");
  });

  it("countUntracked counts only untracked (??) entries", async () => {
    expect(await git.countUntracked()).toBe(0);
    writeFileSync(join(repoRoot, "new-untracked.txt"), "x\n");
    expect(await git.countUntracked()).toBe(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/util/git.test.ts`
Expected: FAIL — `git.init is not a function` (and the other new methods undefined).

- [ ] **Step 3: Implement the new verbs.** In `src/util/git.ts`, add to the `Git` interface (after `currentBranch()` at :9):

```typescript
  init(): Promise<void>;
  listBranches(): Promise<string[]>;
  checkoutBranch(name: string): Promise<void>;
  createBranch(name: string): Promise<void>;
  commitEmpty(message: string): Promise<string>;
  countUntracked(): Promise<number>;
```

And add the implementations to the returned object in `createGit` (e.g. right after `currentBranch` at :34):

```typescript
    async init(): Promise<void> {
      const r = await run(["init"]);
      if (r.exitCode !== 0) fail("init", [], r);
    },

    async listBranches(): Promise<string[]> {
      const r = await run(["branch", "--format=%(refname:short)"]);
      if (r.exitCode !== 0) fail("branch --format", [], r);
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },

    async checkoutBranch(name: string): Promise<void> {
      const r = await run(["checkout", name]);
      if (r.exitCode !== 0) fail("checkout", [name], r);
    },

    async createBranch(name: string): Promise<void> {
      const r = await run(["checkout", "-b", name]);
      if (r.exitCode !== 0) fail("checkout -b", [name], r);
    },

    async commitEmpty(message: string): Promise<string> {
      // Baked identity so the bootstrap commit never fails on a machine with no
      // global user.email/user.name. Used ONLY for this empty init commit — the
      // operator's real commits go through their own git config elsewhere.
      const args = [
        "-c",
        "user.name=Autodev Harness",
        "-c",
        "user.email=autodev@harness.local",
        "commit",
        "--allow-empty",
        "-m",
        message,
      ];
      const r = await run(args);
      if (r.exitCode !== 0) fail("commit --allow-empty", args, r);
      const h = await run(["rev-parse", "HEAD"]);
      if (h.exitCode !== 0) fail("rev-parse HEAD", [], h);
      return h.stdout.trim();
    },

    async countUntracked(): Promise<number> {
      const r = await run(["status", "--porcelain"]);
      if (r.exitCode !== 0) fail("status --porcelain", [], r);
      return r.stdout.split("\n").filter((l) => l.startsWith("??")).length;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/util/git.test.ts`
Expected: PASS (all new + existing git tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/git.ts src/util/git.test.ts
git commit -m "feat(git): add init/listBranches/checkout/createBranch/commitEmpty/countUntracked verbs"
```

---

## Task 2: `ensureAutodevBranch` + `initAutodevRepo` helper (s30 Task 1 mechanism)

**Files:**
- Create: `src/util/ensure-branch.ts`
- Test: `src/util/ensure-branch.test.ts`

- [ ] **Step 1: Write the failing test** — `src/util/ensure-branch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNative } from "./native.js";
import { createGit } from "./git.js";
import { ensureAutodevBranch, initAutodevRepo, DEFAULT_AUTODEV_BRANCH } from "./ensure-branch.js";

let dir: string;

async function initRealRepo(d: string, branch: string): Promise<void> {
  await runNative("git", ["init", "-b", branch], { cwd: d });
  await runNative("git", ["config", "user.email", "t@e.com"], { cwd: d });
  await runNative("git", ["config", "user.name", "T"], { cwd: d });
  writeFileSync(join(d, "f.txt"), "x\n");
  await runNative("git", ["add", "-A"], { cwd: d });
  await runNative("git", ["commit", "-m", "init"], { cwd: d });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adh-ensure-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureAutodevBranch", () => {
  it("no-ops when already on a matching branch", async () => {
    await initRealRepo(dir, "autodev/main");
    const g = createGit(dir);
    const r = await ensureAutodevBranch(g);
    expect(r).toEqual({ branch: "autodev/main", switched: false });
  });

  it("creates autodev/main from master when no autodev branch exists", async () => {
    await initRealRepo(dir, "master");
    const g = createGit(dir);
    const r = await ensureAutodevBranch(g);
    expect(r).toEqual({ branch: DEFAULT_AUTODEV_BRANCH, switched: true });
    expect(await g.currentBranch()).toBe("autodev/main");
  });

  it("switches to an EXISTING autodev branch rather than recreating", async () => {
    await initRealRepo(dir, "master");
    const g = createGit(dir);
    await g.createBranch("autodev/work");
    await g.checkoutBranch("master");
    const r = await ensureAutodevBranch(g);
    expect(r).toEqual({ branch: "autodev/work", switched: true });
    expect(await g.currentBranch()).toBe("autodev/work");
  });

  it("carries a dirty tree over when creating the branch (no stash)", async () => {
    await initRealRepo(dir, "master");
    const g = createGit(dir);
    writeFileSync(join(dir, "f.txt"), "x\nDIRTY\n");
    await ensureAutodevBranch(g);
    expect(await g.currentBranch()).toBe("autodev/main");
    // The uncommitted edit survived the branch switch.
    const status = await runNative("git", ["status", "--porcelain"], { cwd: dir });
    expect(status.stdout).toMatch(/ M f\.txt/);
  });
});

describe("initAutodevRepo", () => {
  it("git-inits a non-repo, lands on autodev/main, leaves files untracked", async () => {
    writeFileSync(join(dir, "existing.txt"), "keep me\n");
    const g = createGit(dir);
    const r = await initAutodevRepo(g);
    expect(r.branch).toBe("autodev/main");
    expect(r.untrackedCount).toBe(1); // existing.txt is NOT auto-committed
    expect(await g.currentBranch()).toBe("autodev/main");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/util/ensure-branch.test.ts`
Expected: FAIL — cannot find module `./ensure-branch.js`.

- [ ] **Step 3: Implement `src/util/ensure-branch.ts`**

```typescript
/**
 * Shared git branch/bootstrap ops for the New Project flow + the conductor
 * branch-guard onboarding fix (s30 Task 1). `ensureAutodevBranch` guarantees a
 * repo is on an `^autodev/` branch (the conductor refuses to run otherwise —
 * `conductor.ts` guard, default pattern `schema.ts`); `initAutodevRepo`
 * git-inits a fresh folder, establishes HEAD via an empty commit (a zero-commit
 * repo cannot create a worktree), and lands it on `autodev/main`. Neither stages
 * or commits the operator's existing files — they stay untracked for the
 * operator to commit their own baseline (spec §2 non-goals).
 *
 * The canonical default branch name is a FIXED `autodev/main` — we never reverse
 * the guard regex to synthesize a name (Task 1 brief).
 */
import type { Git } from "./git.js";

type Log = (level: string, message: string) => void;

export const DEFAULT_AUTODEV_BRANCH = "autodev/main";
export const DEFAULT_AUTODEV_PATTERN = /^autodev\//;

export interface EnsureBranchResult {
  branch: string;
  /** True when we changed the checked-out branch (created or switched). */
  switched: boolean;
}

export interface EnsureBranchOptions {
  /** Guard pattern to satisfy (default `^autodev/`, matching the conductor). */
  pattern?: RegExp;
  /** Name to CREATE when no matching branch exists (default `autodev/main`). */
  defaultBranch?: string;
  log?: Log;
}

/**
 * Put `git`'s repo on a branch matching `pattern`. Already-matching → no-op;
 * a matching branch exists but isn't checked out → switch (never recreate);
 * otherwise create `defaultBranch` from the current HEAD (dirty tree carries
 * over — `git checkout`/`checkout -b` preserve uncommitted changes; we never
 * stash). Requires a born HEAD (call after an initial commit for a fresh repo).
 */
export async function ensureAutodevBranch(git: Git, opts: EnsureBranchOptions = {}): Promise<EnsureBranchResult> {
  const pattern = opts.pattern ?? DEFAULT_AUTODEV_PATTERN;
  const defaultBranch = opts.defaultBranch ?? DEFAULT_AUTODEV_BRANCH;

  const cur = await git.currentBranch();
  if (pattern.test(cur)) return { branch: cur, switched: false };

  const existing = (await git.listBranches()).find((b) => pattern.test(b));
  if (existing !== undefined) {
    await git.checkoutBranch(existing);
    opts.log?.("INFO", `ensure-branch: switched ${cur} -> ${existing}`);
    return { branch: existing, switched: true };
  }

  await git.createBranch(defaultBranch);
  opts.log?.("INFO", `ensure-branch: created ${defaultBranch} from ${cur}`);
  return { branch: defaultBranch, switched: true };
}

/**
 * Turn a NON-git folder into a usable autodev project root: `git init` → empty
 * initial commit (establishes HEAD so worktrees work) → `ensureAutodevBranch`.
 * Existing files stay UNTRACKED (never `git add`-ed); `untrackedCount` lets the
 * UI hint the operator to commit their baseline before the first run.
 */
export async function initAutodevRepo(
  git: Git,
  opts: EnsureBranchOptions = {},
): Promise<{ branch: string; untrackedCount: number }> {
  await git.init();
  await git.commitEmpty("chore: initialize autodev project");
  const { branch } = await ensureAutodevBranch(git, opts);
  const untrackedCount = await git.countUntracked();
  return { branch, untrackedCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/util/ensure-branch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/ensure-branch.ts src/util/ensure-branch.test.ts
git commit -m "feat(git): ensureAutodevBranch + initAutodevRepo (s30 branch-guard mechanism)"
```

---

## Task 3: Folder browser — hide system/hidden dirs

**Files:**
- Modify: `src/fsbrowse/fsbrowse.ts` (the dirents loop at :119-135)
- Test: `src/fsbrowse/fsbrowse.test.ts`

- [ ] **Step 1: Write the failing test** — add to `src/fsbrowse/fsbrowse.test.ts`:

```typescript
  it("hides dot-dirs on all platforms and $/system dirs on win32", async () => {
    mkdirSync(join(base, "Normal"));
    mkdirSync(join(base, ".hidden"));
    mkdirSync(join(base, "$sys"));
    mkdirSync(join(base, "System Volume Information"));
    const win = await listDirs(base, deps({ platform: "win32" }));
    if (!win.ok) throw new Error("expected ok");
    expect(win.entries.map((e) => e.name)).toEqual(["Normal"]);

    const posix = await listDirs(base, deps({ platform: "linux" }));
    if (!posix.ok) throw new Error("expected ok");
    // On POSIX only dot-dirs are hidden; `$sys` / the spaced name are visible.
    expect(posix.entries.map((e) => e.name).sort()).toEqual(
      ["$sys", "Normal", "System Volume Information"].sort(),
    );
  });
```

Note: check the existing `deps(...)` test helper accepts a `{ platform }` override; the module already supports `deps.platform`. If the local `deps()` helper doesn't forward it, extend that helper (it wraps `FsBrowseDeps`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/fsbrowse/fsbrowse.test.ts`
Expected: FAIL — `.hidden`/`$sys`/`System Volume Information` still listed.

- [ ] **Step 3: Implement the filter.** In `src/fsbrowse/fsbrowse.ts`, add near the top (after imports):

```typescript
/** Curated win32 system dir names that are not dot/$ prefixed. */
const WIN32_SYSTEM_DIRS = new Set(["System Volume Information", "$Recycle.Bin", "Config.Msi", "Recovery"]);

/** Protection-from-mistakes (NOT a security boundary): dot-dirs everywhere;
 *  `$`-prefixed + curated system dirs on win32. */
function isHiddenEntry(name: string, platform: NodeJS.Platform): boolean {
  if (name.startsWith(".")) return true;
  if (platform === "win32") {
    if (name.startsWith("$")) return true;
    if (WIN32_SYSTEM_DIRS.has(name)) return true;
  }
  return false;
}
```

Then in `listDirs`, at the very top of the `for (const d of dirents)` loop body (before the `try`), skip hidden entries:

```typescript
  for (const d of dirents) {
    if (isHiddenEntry(d.name, platform)) continue;
    try {
```

(The roots view at :82-92 lists drive letters and is unaffected — filtering only touches child entries.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/fsbrowse/fsbrowse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fsbrowse/fsbrowse.ts src/fsbrowse/fsbrowse.test.ts
git commit -m "feat(fsbrowse): hide dot-dirs (all) and \$/system dirs (win32) from the folder browser"
```

---

## Task 4: git PATH probe (`detectGit`)

**Files:**
- Modify: `src/detect/detect-agents.ts` (export 4 helpers — no behavior change)
- Create: `src/detect/detect-git.ts`
- Test: `src/detect/detect-git.test.ts`

- [ ] **Step 1: Export the shared PATH-probe helpers.** In `src/detect/detect-agents.ts`, add the `export` keyword to these four existing functions (currently module-private): `computeExts` (:158), `defaultPathDirs` (:165), `resolveBinary` (:202), `defaultProbeVersion` (:213). No other change — existing detect-agents tests must stay green.

- [ ] **Step 2: Write the failing test** — `src/detect/detect-git.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGit } from "./detect-git.js";

describe("detectGit", () => {
  it("reports not installed when git is absent from the injected PATH", async () => {
    const empty = mkdtempSync(join(tmpdir(), "adh-nogit-"));
    try {
      const r = await detectGit({ platform: "linux", pathDirs: [empty], probeVersion: async () => null });
      expect(r).toEqual({ installed: false });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("reports installed + version when a git executable is on the injected PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "adh-git-bin-"));
    try {
      const exe = join(bin, "git");
      writeFileSync(exe, "#!/bin/sh\necho 'git version 2.99.0'\n");
      chmodSync(exe, 0o755);
      const r = await detectGit({
        platform: "linux",
        pathDirs: [bin],
        probeVersion: async () => "git version 2.99.0",
      });
      expect(r).toEqual({ installed: true, version: "git version 2.99.0" });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/detect/detect-git.test.ts`
Expected: FAIL — cannot find module `./detect-git.js`.

- [ ] **Step 4: Implement `src/detect/detect-git.ts`**

```typescript
/**
 * Read-only PATH-scan for the `git` binary + a best-effort version. Reuses the
 * PATHEXT-aware executable probe from `detect-agents` (the flip side of
 * `[node/win-cmd-spawn]`/`[detect/executable-probe]`): a bare `existsSync`
 * both misses `git.exe` and false-positives a same-named dir. Powers the New
 * Project screen's git-not-installed banner (spec §3c).
 */
import { computeExts, defaultPathDirs, defaultProbeVersion, resolveBinary } from "./detect-agents.js";

export interface DetectGitResult {
  installed: boolean;
  /** Best-effort first stdout line of `git --version`; present iff probed. */
  version?: string;
}

export interface DetectGitDeps {
  platform?: NodeJS.Platform;
  pathDirs?: string[];
  pathext?: string;
  /** Best-effort version probe; MUST never reject (default spawns `git --version`). */
  probeVersion?: (exePath: string, args: string[]) => Promise<string | null>;
}

export async function detectGit(deps: DetectGitDeps = {}): Promise<DetectGitResult> {
  const platform = deps.platform ?? process.platform;
  const pathDirs = deps.pathDirs ?? defaultPathDirs(platform);
  const exts = computeExts(platform, deps.pathext);
  const probeVersion = deps.probeVersion ?? defaultProbeVersion;

  const resolved = resolveBinary(["git"], pathDirs, exts, platform);
  if (resolved === null) return { installed: false };

  let version: string | null;
  try {
    version = await probeVersion(resolved, ["--version"]);
  } catch {
    version = null;
  }
  return { installed: true, ...(version !== null ? { version } : {}) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/detect/detect-git.test.ts src/detect/detect-agents.test.ts`
Expected: PASS (detect-git + unchanged detect-agents).

- [ ] **Step 6: Commit**

```bash
git add src/detect/detect-agents.ts src/detect/detect-git.ts src/detect/detect-git.test.ts
git commit -m "feat(detect): git PATH probe (detectGit) reusing the executable-probe helpers"
```

---

## Task 5: `admin` — drop git gate, add `initGit`, ensure-branch on register

**Files:**
- Modify: `src/registry/admin.ts` (types :36-40, `ProjectAdmin` :52-68, `createProjectAdmin` deps :70, `register` :84-144)
- Test: `src/registry/admin.test.ts`

- [ ] **Step 1: Write the failing tests** — add to `src/registry/admin.test.ts`. (The existing register happy-path tests fake `.git` via `mkdirSync(join(p, ".git"))`; because register now calls ensure-branch on a `.git`-present path, inject a spy `gitOps` in those and the new tests so no real git runs on a fake repo.)

```typescript
  it("registers a NON-git folder (git gate dropped); no ensure-branch runs", async () => {
    const p = mkdtempSync(join(tmpdir(), "adh-nogit-"));
    let ensureCalls = 0;
    const admin = createProjectAdmin({
      registryFile,
      gitOps: {
        ensureAutodevBranch: async () => {
          ensureCalls++;
          return { branch: "autodev/main", switched: true };
        },
        initAutodevRepo: async () => ({ branch: "autodev/main", untrackedCount: 0 }),
      },
    });
    const r = await admin.register({ path: p, scaffold: false });
    expect(r.ok).toBe(true);
    expect(ensureCalls).toBe(0); // no .git -> no branch ensure
  });

  it("ensures the autodev branch when registering an existing git repo", async () => {
    const p = mkdtempSync(join(tmpdir(), "adh-git-"));
    mkdirSync(join(p, ".git"));
    let ensured = "";
    const admin = createProjectAdmin({
      registryFile,
      gitOps: {
        ensureAutodevBranch: async () => {
          ensured = "autodev/main";
          return { branch: "autodev/main", switched: true };
        },
        initAutodevRepo: async () => ({ branch: "autodev/main", untrackedCount: 0 }),
      },
    });
    const r = await admin.register({ path: p, scaffold: false });
    expect(r.ok).toBe(true);
    expect(ensured).toBe("autodev/main");
  });

  it("initGit rejects a path that is already a git repo", async () => {
    const p = mkdtempSync(join(tmpdir(), "adh-already-"));
    mkdirSync(join(p, ".git"));
    const admin = createProjectAdmin({ registryFile });
    const r = await admin.initGit(p);
    expect(r).toEqual({ ok: false, code: "already_git_repo", message: expect.any(String) });
  });

  it("initGit turns a non-git folder into a git repo (via injected gitOps)", async () => {
    const p = mkdtempSync(join(tmpdir(), "adh-init-"));
    const admin = createProjectAdmin({
      registryFile,
      gitOps: {
        ensureAutodevBranch: async () => ({ branch: "autodev/main", switched: true }),
        initAutodevRepo: async () => ({ branch: "autodev/main", untrackedCount: 2 }),
      },
    });
    const r = await admin.initGit(p);
    expect(r).toEqual({ ok: true, branch: "autodev/main", untrackedCount: 2 });
  });
```

Ensure the file imports `mkdirSync`, `mkdtempSync`, `rmSync`, `tmpdir`, `join` (extend the existing import lines if needed).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/registry/admin.test.ts`
Expected: FAIL — `createProjectAdmin` has no `gitOps` dep / `admin.initGit` is not a function; and the non-git register still returns `not_a_git_repo`.

- [ ] **Step 3: Implement.** In `src/registry/admin.ts`:

(a) Add imports at the top:

```typescript
import { createGit } from "../util/git.js";
import { ensureAutodevBranch, initAutodevRepo } from "../util/ensure-branch.js";
```

(b) Add the git-init result types near the other type unions (after :50):

```typescript
export type GitInitErrorCode = "invalid_path" | "already_git_repo" | "git_unavailable";

export type GitInitResult =
  | { ok: true; branch: string; untrackedCount: number }
  | { ok: false; code: GitInitErrorCode; message: string };

/** Injectable git bootstrap ops (default: real, via `createGit`). Tests override
 *  so registry unit tests never shell out to git on a fake `.git` dir. */
export interface AdminGitOps {
  ensureAutodevBranch(repoRoot: string): Promise<{ branch: string; switched: boolean }>;
  initAutodevRepo(repoRoot: string): Promise<{ branch: string; untrackedCount: number }>;
}
```

(c) Add `initGit` to the `ProjectAdmin` interface (after `register` at :53):

```typescript
  /** Turn a NON-git folder into a git repo on an `^autodev/` branch (empty
   *  bootstrap commit; existing files stay untracked). Rejects a path already
   *  under git. Registry-independent (does NOT register). */
  initGit(path: string): Promise<GitInitResult>;
```

(d) Change the `createProjectAdmin` signature to accept `gitOps` with a real default:

```typescript
export function createProjectAdmin(deps: {
  registryFile: string;
  log?: Log;
  gitOps?: AdminGitOps;
}): ProjectAdmin {
  const gitOps: AdminGitOps = deps.gitOps ?? {
    ensureAutodevBranch: (root) => ensureAutodevBranch(createGit(root), { log: deps.log }),
    initAutodevRepo: (root) => initAutodevRepo(createGit(root), { log: deps.log }),
  };
```

(e) In `register`, DELETE the git gate at :104-107 (the `if (!existsSync(join(real, ".git")))` block returning `not_a_git_repo`). After the scaffold block (after :133, before the registry append at :135), add the ensure-branch call:

```typescript
        // Put an existing git repo on an `^autodev/` branch so its first run
        // clears the conductor guard (s30 Task 1). A non-git folder registers
        // as-is (it can't run until `initGit`); we only ensure-branch when a
        // repo is present. Best-effort must NOT block registration — log + carry on.
        if (existsSync(join(real, ".git"))) {
          try {
            await gitOps.ensureAutodevBranch(real);
          } catch (err) {
            deps.log?.("WARN", `admin: ensure-branch failed for ${real}: ${String(err)}`);
          }
        }
```

(f) Add the `initGit` method to the returned object (e.g. after `register`'s closing `},`):

```typescript
    initGit(path) {
      return withLock(async (): Promise<GitInitResult> => {
        let real: string;
        try {
          real = await realpath(path);
        } catch {
          return { ok: false, code: "invalid_path", message: `path does not exist: ${path}` };
        }
        let st;
        try {
          st = await stat(real);
        } catch {
          return { ok: false, code: "invalid_path", message: `path is not accessible: ${path}` };
        }
        if (!st.isDirectory()) {
          return { ok: false, code: "invalid_path", message: `not a directory: ${path}` };
        }
        if (existsSync(join(real, ".git"))) {
          return { ok: false, code: "already_git_repo", message: `already a git repository: ${real}` };
        }
        try {
          const { branch, untrackedCount } = await gitOps.initAutodevRepo(real);
          deps.log?.("INFO", `admin: git-init ${real} -> ${branch} (${untrackedCount} untracked)`);
          return { ok: true, branch, untrackedCount };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, code: "git_unavailable", message: "git is not installed or not on PATH" };
          }
          throw err; // real git/fs failure -> route's top-level catch -> 500
        }
      });
    },
```

(g) `RegisterErrorCode` still lists `not_a_git_repo` (:36). Grep for other references (`git grep not_a_git_repo`); if nothing outside the type consumes it, remove the member. If the UI or server references it, leave it (dead but harmless) and note so.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/registry/admin.test.ts`
Expected: PASS. If a pre-existing register happy-path test now fails because it faked `.git` and hit the REAL default gitOps, inject the spy `gitOps` (as in the new tests) into that test's `createProjectAdmin` call.

- [ ] **Step 5: Commit**

```bash
git add src/registry/admin.ts src/registry/admin.test.ts
git commit -m "feat(admin): drop git gate, add initGit, ensure ^autodev/ branch on register"
```

---

## Task 6: server endpoints — `POST /fs/git-init`, `GET /system/git`

**Files:**
- Modify: `src/api/server.ts` (admin deps :224-232, handlers near :940-960, routes :1560-1565, imports)
- Test: `src/api/server.test.ts`

- [ ] **Step 1: Write the failing tests** — add to `src/api/server.test.ts`. Extend the existing `fakeAdmin()` helper (near :2160) so its stub exposes `initGit` and `detectGit`; then:

```typescript
describe("POST /fs/git-init", () => {
  it("404s when no admin port is configured", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\\x" }),
    });
    expect(res.status).toBe(404);
  });

  it("200s with { branch, untrackedCount } on success", async () => {
    const { admin } = fakeAdmin({
      initGit: async () => ({ ok: true, branch: "autodev/main", untrackedCount: 3 }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\\x" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branch: "autodev/main", untrackedCount: 3 });
  });

  it("409s for an already-git repo, 400 for other typed codes", async () => {
    const { admin } = fakeAdmin({
      initGit: async () => ({ ok: false, code: "already_git_repo", message: "already a git repository" }),
    });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\\x" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("already_git_repo");
  });

  it("400s on a missing path", async () => {
    const { admin } = fakeAdmin();
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/fs/git-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /system/git", () => {
  it("404s without an admin port", async () => {
    handle = createApiServer(projectDeps({ repo, stateDir }));
    const port = await handle.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/system/git`)).status).toBe(404);
  });

  it("200s with the detect result", async () => {
    const { admin } = fakeAdmin({ detectGit: async () => ({ installed: true, version: "git version 2.44.0" }) });
    handle = createApiServer(projectDeps({ repo, stateDir }, { admin }));
    const port = await handle.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/system/git`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installed: true, version: "git version 2.44.0" });
  });
});
```

Update the `fakeAdmin()` helper so it accepts optional overrides and its returned `admin` includes default `initGit: async () => ({ ok: true, branch: "autodev/main", untrackedCount: 0 })` and `detectGit: async () => ({ installed: true })`, merged with the passed overrides.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/api/server.test.ts`
Expected: FAIL — routes 404 (unrouted) / `deps.admin.initGit` undefined.

- [ ] **Step 3: Implement.** In `src/api/server.ts`:

(a) Import the new types (find the existing import from `../registry/admin.js`) — add `GitInitResult` and, from `../detect/detect-git.js`, `DetectGitResult`:

```typescript
import type { /* …existing… */ GitInitResult } from "../registry/admin.js";
import type { DetectGitResult } from "../detect/detect-git.js";
```

(b) Extend the `admin?: { … }` deps interface (:224-232) with:

```typescript
    /** Turn a non-git folder into a git repo on an `^autodev/` branch (New Project init). */
    initGit(path: string): Promise<GitInitResult>;
    /** Is `git` installed / on PATH (best-effort, never throws). */
    detectGit(): Promise<DetectGitResult>;
```

(c) Add the two handlers next to `handleDetectAgents` (near :946):

```typescript
  /** POST /fs/git-init — `git init` + `^autodev/` branch for a non-git folder.
   *  Body shape only here; the admin port owns path validation + typed codes. */
  async function handleGitInit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "request body too large" }));
        res.on("finish", () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const parsed = body as { path?: unknown } | null;
    if (typeof parsed?.path !== "string" || parsed.path.trim() === "") {
      sendJson(res, 400, { error: "path must be a non-empty string" });
      return;
    }
    const result = await deps.admin.initGit(parsed.path);
    if (result.ok) {
      sendJson(res, 200, { branch: result.branch, untrackedCount: result.untrackedCount });
      return;
    }
    sendJson(res, result.code === "already_git_repo" ? 409 : 400, { error: result.message, code: result.code });
  }

  /** GET /system/git — is git installed. Best-effort/never-throws (admin gate only). */
  async function handleSystemGit(res: ServerResponse): Promise<void> {
    if (!deps.admin) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, await deps.admin.detectGit());
  }
```

(d) Add routes after the `/agents/detect` route (:1565):

```typescript
    if (req.method === "POST" && (url.pathname === "/fs/git-init" || url.pathname === "/fs/git-init/")) {
      return void (await handleGitInit(req, res));
    }
    if (req.method === "GET" && (url.pathname === "/system/git" || url.pathname === "/system/git/")) {
      return void (await handleSystemGit(res));
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/api/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/server.ts src/api/server.test.ts
git commit -m "feat(api): POST /fs/git-init + GET /system/git endpoints"
```

---

## Task 7: composition root — wire endpoints + defensive startup ensure-branch

**Files:**
- Modify: `src/index.ts` (imports :10-22, serve block :122-198)

- [ ] **Step 1: Add imports.** In `src/index.ts` near the other imports:

```typescript
import { createGit } from "./util/git.js";
import { ensureAutodevBranch } from "./util/ensure-branch.js";
import { detectGit } from "./detect/detect-git.js";
```

(`existsSync`, `join`, `loadRegistry` are already imported.)

- [ ] **Step 2: Wire the new admin methods.** In the `admin: { … }` object passed to `createApiServer` (:173-187), add after `detectAgents`:

```typescript
        initGit: (path) => admin.initGit(path),
        detectGit: () => detectGit({}),
```

- [ ] **Step 3: Add the defensive startup ensure-branch pass.** Right after `const admin = createProjectAdmin({ registryFile, log });` (:136), insert:

```typescript
    // Defensive branch-ensure for ALREADY-registered projects (s30 Task 1): a
    // project left on master/main can't run (conductor guard). Best-effort /
    // never-throws — one broken project must not abort the whole daemon start.
    try {
      const { projects } = await loadRegistry(registryFile, log);
      for (const entry of projects) {
        try {
          if (!existsSync(join(entry.path, ".git"))) continue;
          const r = await ensureAutodevBranch(createGit(entry.path), { log });
          if (r.switched) log("INFO", `serve: ${entry.path} -> branch ${r.branch}`);
        } catch (err) {
          log("WARN", `serve: ensure-branch failed for ${entry.path}: ${String(err)}`);
        }
      }
    } catch (err) {
      log("WARN", `serve: branch-ensure startup pass skipped: ${String(err)}`);
    }
```

- [ ] **Step 4: Verify the whole backend compiles + all tests green**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite PASS (766 prior + the new tests). `src/index.ts` is untested glue by design (gotcha `[conductor/wiring]`) — it is covered by the Task 11 live smoke.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(serve): wire git-init/system-git endpoints + defensive startup branch-ensure"
```

---

## ▶ CODEX GATE — backend (Tasks 1–7)

- [ ] Build the full inline diff of the backend change (all of Tasks 1–7) and run the **codex GPT-5.5 critic** per the `[critic/codex]` recipe: NO-TOOLS preamble + embedded full `git diff` (add new files with `git add -N` first so they appear) + FOREGROUND `codex exec -m gpt-5.5 -c model_reasoning_effort="high" -c approval_policy="never" -s read-only -C D:/Projects/autodev-harness --skip-git-repo-check -`.
- [ ] Triage findings WITH the operator's discipline: fix real defects with a regression test; **re-critic every in-place fix**; never self-certify. Focus areas to prime the critic: the `commitEmpty` baked-identity (does it leak into the operator's real commits? — it must not, it's per-invocation `-c`), the ENOENT→`git_unavailable` mapping, `ensureAutodevBranch` on a detached/unborn HEAD, the register best-effort ensure-branch swallowing errors (is silent-carry-on correct here vs surfacing?), and the win32 hidden-dir set completeness.
- [ ] Only proceed to UI once the backend is codex-clean (or findings are fixed + re-critic clean).

---

## Task 8: UI client + hooks

**Files:**
- Modify: `ui/src/lib/api.ts` (the `api` object at :301; types near the top)
- Modify: `ui/src/lib/queries.ts` (hooks near :176-205)

- [ ] **Step 1: Add types + client methods.** In `ui/src/lib/api.ts`, add the response types (near the other interfaces) and two methods to the `api` object:

```typescript
export interface SystemGitStatus {
  installed: boolean;
  version?: string;
}
export interface GitInitResponse {
  branch: string;
  untrackedCount: number;
}
```

```typescript
  /** Daemon-global: is git installed. 404s when the daemon has no admin port. */
  getSystemGit: () => req<SystemGitStatus>("/system/git"),

  /** `git init` + `^autodev/` branch for a non-git folder. 200 {branch,untrackedCount} / 409 / 400. */
  gitInit: (path: string) =>
    req<GitInitResponse>("/fs/git-init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
```

- [ ] **Step 2: Add hooks.** In `ui/src/lib/queries.ts`, after `useFsDirs` (:177):

```typescript
/** Is git installed (daemon-global). Short staleTime; the New Project screen reads it once on load. */
export const useSystemGit = () =>
  useQuery({ queryKey: ["system-git"], queryFn: api.getSystemGit, staleTime: 30_000 });

/** `git init` a non-git folder; invalidates the folder listing so the row re-renders as a git repo. */
export const useGitInit = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.gitInit(path),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["fs-dirs"] }),
  });
};
```

- [ ] **Step 3: Typecheck the UI**

Run: `cd ui && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/api.ts ui/src/lib/queries.ts
git commit -m "feat(ui): getSystemGit/gitInit clients + useSystemGit/useGitInit hooks"
```

---

## Task 9: `FolderBrowser` — any-folder select + inline "init git"

**Files:**
- Modify: `ui/src/components/FolderBrowser.tsx`

- [ ] **Step 1: Extend the component props** to receive git availability + an init callback:

```typescript
export function FolderBrowser({
  selectedPath,
  onSelect,
  gitInstalled,
  onInitialized,
}: {
  selectedPath: string | null;
  onSelect: (entry: FsDirEntry) => void;
  gitInstalled: boolean;
  onInitialized?: (result: GitInitResponse) => void;
}) {
  const gitInit = useGitInit();
```

Import `useGitInit` from `@/lib/queries` and the `GitInitResponse` type from `@/lib/api`.

- [ ] **Step 2: Replace the per-row action logic.** Currently (:45-88) `selectable = entry.isGitRepo && !entry.isRegistered` and only a "select" pill renders. Change the trailing action so:
  - `entry.isRegistered` → the existing `registered` badge (unchanged).
  - `!entry.isRegistered && entry.isGitRepo` → the existing `select` button (drop the `entry.isGitRepo &&` guard is not needed here since this arm already requires it).
  - `!entry.isRegistered && !entry.isGitRepo` → a muted `no git` label + an `init git` button:

```tsx
                {!entry.isRegistered && !entry.isGitRepo && (
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">no git</span>
                    <button
                      type="button"
                      disabled={!gitInstalled || gitInit.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        gitInit.mutate(entry.path, { onSuccess: (r) => onInitialized?.(r) });
                      }}
                      title={gitInstalled ? "git init + create an autodev/ branch" : "git is not installed"}
                      className="rounded-md border border-border px-2 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      {gitInit.isPending ? "initializing…" : "init git"}
                    </button>
                  </span>
                )}
```

Keep the existing `select` button for the git-and-unregistered arm (it already sits at `ml-auto`). The `select` arm's condition becomes `!entry.isRegistered && entry.isGitRepo`.

- [ ] **Step 3: Surface an init error inline** (non-blocking). Below the `<ul>` (near :93), when `gitInit.isError`, render a small line:

```tsx
      {gitInit.isError && (
        <p className="mt-2 px-2.5 text-xs text-broken">init git failed: {(gitInit.error as Error).message}</p>
      )}
```

- [ ] **Step 4: Typecheck the UI**

Run: `cd ui && npm run typecheck`
Expected: clean (the caller in Task 10 supplies the new required `gitInstalled` prop).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/FolderBrowser.tsx
git commit -m "feat(ui): any-folder select + inline 'init git' action in the folder browser"
```

---

## Task 10: `NewProjectView` — git banner + "Install it now" + untracked hint

**Files:**
- Modify: `ui/src/views/NewProjectView.tsx`

- [ ] **Step 1: Read git status + wire the new FolderBrowser props.** Add `useSystemGit` and local state for the last-init hint:

```tsx
  const git = useSystemGit();
  const gitInstalled = git.data?.installed ?? true; // optimistic until known; the banner only shows on explicit false
  const [initHint, setInitHint] = useState<GitInitResponse | null>(null);
```

Pass to `<FolderBrowser … gitInstalled={gitInstalled} onInitialized={setInitHint} />`.

Import `useSystemGit` from `@/lib/queries`, `GitInitResponse` from `@/lib/api`.

- [ ] **Step 2: Render the git-not-installed banner** at the top of the main region (only when detection returned `installed === false`):

```tsx
      {git.data && !git.data.installed && (
        <div className="flex items-center gap-3 border-b border-border bg-broken/10 px-4 py-2.5 text-sm">
          <span className="text-foreground">
            git is not installed — the harness needs it to initialize and orchestrate projects.
          </span>
          <a
            href="https://git-scm.com/downloads"
            target="_blank"
            rel="noreferrer"
            className="ml-auto rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:bg-muted"
          >
            Install it now
          </a>
          <code className="font-mono text-[11px] text-muted-foreground">winget install Git.Git · brew install git</code>
        </div>
      )}
```

- [ ] **Step 3: Render the untracked-files hint** after a successful init (near the browser / register column):

```tsx
      {initHint && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Initialized on <code className="font-mono">{initHint.branch}</code>.
          {initHint.untrackedCount > 0
            ? ` ${initHint.untrackedCount} untracked file(s) — commit your baseline before the first run.`
            : ""}
        </p>
      )}
```

- [ ] **Step 4: Typecheck + build the UI**

Run: `cd ui && npm run typecheck && npm run build`
Expected: clean + built.

- [ ] **Step 5: Commit**

```bash
git add ui/src/views/NewProjectView.tsx
git commit -m "feat(ui): git-not-installed banner + Install it now + untracked-files hint"
```

---

## Task 11: Integration verify, docs, gate, merge

- [ ] **Step 1: Full green bar.** Run: `npm run typecheck && npm test && npm run build && cd ui && npm run typecheck && npm run build`. Expected: all green; test count = 766 prior + new (git ~4, ensure-branch ~5, fsbrowse ~1, detect-git ~2, admin ~4, server ~6).

- [ ] **Step 2: Rebuild BOTH bundles then live-smoke** (gotchas `[build/stale-dist-backend]` + `[ops/daemon-run]`): `npm run build` (→ `dist/index.js`) AND `npm run build:ui` (→ `dist/ui`), then `node dist/index.js serve` → open `http://127.0.0.1:4319/` → New Project. Drive: (a) a non-git folder shows `no git · init git` → click → row becomes git repo on `autodev/main` + untracked hint; (b) select → register; (c) confirm (temporarily rename `git` off PATH, or stub) the git-not-installed banner + "Install it now"; (d) confirm the already-registered `D:\Projects\wordpress\woodev-shipping-plugin-test` (on `master`) auto-switched to `autodev/main` at startup (check `daemon.log` for the `-> branch autodev/main` line) and its first run no longer trips the guard. Screenshot to operator.

- [ ] **Step 3: Docs.** Update `docs/CURRENT-STATE.md` (retire the s30 priority block — Task 1 delivered here; note orphan/dedup still open), prepend a `docs/SESSION-LOG.md` entry, and if the live smoke surfaced a non-obvious behavior add a `docs/gotchas/{slug}.md` + `GOTCHAS.md` index line (candidate: "register auto-switches the operator's checked-out branch" / "empty-init leaves an all-untracked tree that blocks the first merge").

- [ ] **Step 4: Merge.** Squash-merge `autodev/s30-onboarding-redesign` → `main` after the codex gate is clean + CI green (`gh pr merge <n> --squash --delete-branch` as a BARE command), then `git merge --ff-only origin/main`. This is a substantive batch → its own PR (per AGENTS.md batch-merges).

---

## Self-review notes (author)

- **Spec coverage:** §3a picker/hidden → Tasks 3,5,9; §3b init git → Tasks 1,2,5,6,9,10; §3c git-not-installed → Tasks 4,6,8,10; §3d ensureAutodevBranch (Task 1 fix) → Tasks 2,5,7; §3e Git verbs → Task 1. All covered.
- **Type consistency:** `GitInitResult`/`GitInitResponse` (server union vs UI body), `SystemGitStatus`/`DetectGitResult` (UI vs server), `AdminGitOps.{ensureAutodevBranch,initAutodevRepo}` names match `ensure-branch.ts` exports and admin defaults; `ensureAutodevBranch` returns `{branch,switched}` everywhere; `initAutodevRepo` returns `{branch,untrackedCount}` everywhere.
- **Open caveat carried from spec:** `ensureAutodevBranch` creates the fixed `autodev/main`; a project with a CUSTOM `allowedBranchPattern` that `autodev/main` doesn't satisfy won't be auto-fixed (logged, not silently wrong). The defensive-startup pass uses the default pattern (not each project's `cfg.allowedBranchPattern`) for MVP simplicity — acceptable since scaffold writes the default; flag for the critic.
