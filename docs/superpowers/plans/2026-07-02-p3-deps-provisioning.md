# Deps-Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision gitignored dependency dirs (e.g. `vendor`, `plugins-reference`) into each per-task git worktree via symlink/junction, so the gate graduates `php -l → composer check` — proven on a clone of `woodev_framework`.

**Architecture:** A new `worktree.provision` config list (root-`.strict()` schema, validated). The existing `createWorktreeManager` gains a third `opts` arg; `create()` links each configured dir from the main repo into the fresh worktree AFTER `git worktree add`; `teardown()` (and the re-queue stale-cleanup inside `create()`) remove ONLY the link entries — never a recursive delete — BEFORE any recursive worktree removal, so a leaked junction can never traverse into the clone's real deps. Empty list = feature off (full backward compat).

**Tech Stack:** Node LTS + TypeScript (ESM, `.js` import paths, strict `NodeNext`), zod config, vitest. Windows = directory junctions; POSIX = directory symlinks.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/config/schema.ts` | zod config schema | ADD a `worktree.provision` block + path-safety refine |
| `src/config/config.test.ts` | config tests | ADD provision default / accept / reject tests |
| `src/worktree/worktree.ts` | per-task worktree lifecycle | ADD `opts` arg, provision-on-create, unlink-on-teardown + in stale-cleanup |
| `src/worktree/worktree.test.ts` | worktree tests | ADD provision + safety tests |
| `src/index.ts` | composition root | WIRE `cfg.worktree.provision` + `log` into the manager (untested glue) |
| `docs/superpowers/plans/2026-07-02-p3-deps-provisioning.md` | this plan | — |

**Discipline reminder:** all code tasks below are enforcement-adjacent → after Task 7 (code complete, typecheck + tests green), run the **independent codex GPT-5.5 gate** on the diff, fix findings with regression tests, **re-critic every fix**. Only then the ops task (live proof). Never self-certify.

---

## Task 1: Config — `worktree.provision` block

**Files:**
- Modify: `src/config/schema.ts` (add import + a `worktree` key in `HarnessConfigSchema`, before the closing `})` + `.strict()`)
- Test: `src/config/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/config/config.test.ts` inside the existing `describe("loadConfig", …)` block (it already imports `loadConfig`, `writeFileSync`, `join`, `mkdirSync`; the `dir` fixture has a `.autodev/` created in `beforeEach`):

```ts
it("defaults worktree.provision to an empty list", async () => {
  const cfg = await loadConfig(dir);
  expect(cfg.worktree.provision).toEqual([]);
});

it("accepts a worktree.provision list", async () => {
  writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: [vendor, plugins-reference]\n");
  const cfg = await loadConfig(dir);
  expect(cfg.worktree.provision).toEqual(["vendor", "plugins-reference"]);
});

it("rejects a worktree.provision entry with a .. segment", async () => {
  writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['../escape']\n");
  await expect(loadConfig(dir)).rejects.toThrow(/provision/);
});

it("rejects an absolute worktree.provision entry", async () => {
  writeFileSync(join(dir, ".autodev", "config.yaml"), "worktree:\n  provision: ['/etc']\n");
  await expect(loadConfig(dir)).rejects.toThrow(/provision/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/config.test.ts`
Expected: FAIL — the first test throws (`cfg.worktree` is undefined) or `.strict()` rejects the unknown `worktree` key in the accept test.

- [ ] **Step 3: Add the schema block**

In `src/config/schema.ts`, add the import at the top (after the `zod` import):

```ts
import { isAbsolute } from "node:path";
```

Then add this key inside `HarnessConfigSchema = z.object({ … })`, immediately after the `repoRoot` block (before `gate`):

```ts
  // Gitignored dependency dirs (e.g. vendor, plugins-reference) to link into
  // each per-task worktree so a real gate (composer check / phpunit) can run.
  // Each entry is a relative path WITHIN the repo: it is used as both a link
  // target under repoRoot and a link path under the worktree, and teardown
  // removes it, so an absolute path or a `..` segment is rejected (fail-loud
  // here; the worktree manager guards again at the fs-op site). Empty = off.
  worktree: z
    .object({
      provision: z
        .array(z.string())
        .superRefine((arr, ctx) => {
          for (const p of arr) {
            if (p === "" || isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `worktree.provision entry must be a relative path within the repo (no absolute, no "..") : ${JSON.stringify(p)}`,
              });
            }
          }
        })
        .default([]),
    })
    .default({ provision: [] }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/config/config.test.ts`
Expected: PASS (all four new tests + the existing ones).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/config/config.test.ts
git commit -m "feat(config): worktree.provision list (relative-path-validated)"
```

---

## Task 2: Worktree manager — `opts` arg + provision-off regression pin

**Files:**
- Modify: `src/worktree/worktree.ts` (imports, `WorktreeManagerOptions`, factory signature, `safeLog`, helpers)
- Test: `src/worktree/worktree.test.ts`

This task extends the factory signature and adds the (still-empty-by-default) provisioning plumbing WITHOUT changing behavior when `provision` is empty.

- [ ] **Step 1: Write the failing regression-pin test**

Add to `src/worktree/worktree.test.ts` inside `describe("createWorktreeManager", …)` (it already imports `existsSync`, `writeFileSync`, `join`; ADD `mkdirSync`, `readFileSync` to the `node:fs` import line at the top):

```ts
it("provision: with no provision config, create() adds no extra links (behavior unchanged)", async () => {
  mkdirSync(join(repoRoot, "deps"));
  const wt = await manager.create("t-noprov", "main"); // default manager: no provision
  expect(existsSync(join(wt.path, "deps"))).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/worktree/worktree.test.ts -t "behavior unchanged"`
Expected: FAIL only if the manager already misbehaves — more likely it PASSES trivially (no provision yet). That's fine: this test is the regression pin for later tasks. If it passes now, proceed; if the import edit broke compile, fix the import.

- [ ] **Step 3: Extend the manager plumbing**

In `src/worktree/worktree.ts`, replace the import block at the top:

```ts
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createGit, type MergeResult } from "../util/git.js";
import { runNative } from "../util/native.js";
```

with:

```ts
import { rm, symlink, unlink, rmdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { createGit, type MergeResult } from "../util/git.js";
import { runNative } from "../util/native.js";
import type { Logger } from "../util/log.js";
```

Add this interface just above `export interface Worktree {`:

```ts
export interface WorktreeManagerOptions {
  /**
   * Repo-root-relative dir paths (e.g. ["vendor", "plugins-reference"]) to link
   * into each worktree so a real gate can find gitignored deps. Empty = off.
   */
  provision?: string[];
  /** Optional logger for provision warnings (missing target, skips, failures). */
  log?: Logger;
}
```

Change the factory signature from:

```ts
export function createWorktreeManager(mainRepoRoot: string, worktreesDir: string): WorktreeManager {
  const mainGit = createGit(mainRepoRoot);
```

to:

```ts
export function createWorktreeManager(
  mainRepoRoot: string,
  worktreesDir: string,
  opts: WorktreeManagerOptions = {},
): WorktreeManager {
  const mainGit = createGit(mainRepoRoot);
  const provision = opts.provision ?? [];
  // Never throw from logging inside a best-effort / catch path (gotcha [ts/fail-closed]).
  const safeLog: Logger = (level, message) => {
    try {
      opts.log?.(level, message);
    } catch {
      /* logging must never break provisioning */
    }
  };

  // A provision entry must be a relative path within the repo (no absolute, no
  // `..` segment). Config-load validates this too (fail-loud); this is the
  // defense-in-depth guard at the fs-op site — the manager is also constructed
  // directly (in tests) without going through config.
  const isSafeProvisionEntry = (p: string): boolean =>
    p !== "" && !isAbsolute(p) && !p.split(/[\\/]/).includes("..");

  // Link each configured dir from the main repo into a fresh worktree. Runs
  // AFTER `git worktree add`. Best-effort: never throws (a throw here would
  // abort the whole task loop) — logs loudly and continues. A missing target is
  // skipped (no dangling link) so the gate fails honestly instead.
  const provisionWorktree = async (wtPath: string): Promise<void> => {
    for (const p of provision) {
      if (!isSafeProvisionEntry(p)) {
        safeLog("WARN", `provision: unsafe entry skipped: ${JSON.stringify(p)}`);
        continue;
      }
      const target = join(mainRepoRoot, p);
      const link = join(wtPath, p);
      try {
        if (!existsSync(target)) {
          safeLog("WARN", `provision: target missing, skipping ${p} (${target})`);
          continue;
        }
        if (existsSync(link)) {
          safeLog("WARN", `provision: path already exists in worktree, skipping ${p}`);
          continue;
        }
        await mkdir(dirname(link), { recursive: true });
        await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        safeLog("WARN", `provision: failed to link ${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Remove ONLY the link entry — NEVER recurse into its target. `unlink` clears a
  // file-symlink (and POSIX dir-symlinks); a Windows junction / dir needs
  // `rmdir`. Non-recursive `rmdir` can NEVER delete a populated real directory
  // (ENOTEMPTY), so an anomalous real dir at the link path is left intact. This
  // is THE safety invariant: a leaked junction must never let a recursive delete
  // reach the clone's real deps.
  const removeLinkOnly = async (link: string): Promise<void> => {
    try {
      await unlink(link);
      return;
    } catch {
      /* not a plain file-symlink; fall through to rmdir */
    }
    try {
      await rmdir(link); // junction / dir-symlink / empty dir; populated real dir -> ENOTEMPTY (left intact)
    } catch {
      /* absent, or a populated real dir we must not delete */
    }
  };

  // Unlink all provisioned links at a worktree path. MUST run before any
  // recursive removal of that path (git worktree remove / rm -rf).
  const deprovisionWorktree = async (wtPath: string): Promise<void> => {
    for (const p of provision) {
      if (!isSafeProvisionEntry(p)) continue;
      await removeLinkOnly(join(wtPath, p));
    }
  };
```

(These helpers are added but not yet CALLED — that happens in Tasks 3–6. Adding them now keeps the diff reviewable and lets the empty-provision path compile.)

- [ ] **Step 4: Run the regression pin + typecheck**

Run: `npx vitest run src/worktree/worktree.test.ts`
Expected: PASS (all existing tests + the new regression pin; `provision` is `[]` so nothing links).

Run: `npm run typecheck`
Expected: no errors. (If `removeLinkOnly`/`provisionWorktree`/`deprovisionWorktree` trip `noUnusedLocals`, proceed straight to Task 3 which calls them, then re-run — or temporarily wire them in Task 3 within the same working session before committing.)

- [ ] **Step 5: Commit**

```bash
git add src/worktree/worktree.ts src/worktree/worktree.test.ts
git commit -m "feat(worktree): manager opts (provision list + logger) + link helpers"
```

---

## Task 3: Provision on `create()` + link resolves to target

**Files:**
- Modify: `src/worktree/worktree.ts` (`create()` — call `provisionWorktree` after `worktreeAdd`)
- Test: `src/worktree/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("provision: links configured dirs into the worktree; the link resolves to the target", async () => {
  mkdirSync(join(repoRoot, "deps"));
  writeFileSync(join(repoRoot, "deps", "dep.txt"), "installed\n");
  const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
  const wt = await m.create("t-prov", "main");

  // Content is visible THROUGH the link.
  expect(readFileSync(join(wt.path, "deps", "dep.txt"), "utf8")).toBe("installed\n");
  // It's a link, not a copy: a new file in the target shows through the worktree.
  writeFileSync(join(repoRoot, "deps", "extra.txt"), "x\n");
  expect(existsSync(join(wt.path, "deps", "extra.txt"))).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/worktree/worktree.test.ts -t "resolves to the target"`
Expected: FAIL — `readFileSync` throws ENOENT (`wt.path/deps` does not exist; provisioning not called yet).

- [ ] **Step 3: Call `provisionWorktree` in `create()`**

In `create()`, the last two lines are currently:

```ts
      await mainGit.worktreeAdd(path, branch, baseBranch);
      return { path, branch, taskId };
```

Change to:

```ts
      await mainGit.worktreeAdd(path, branch, baseBranch);
      await provisionWorktree(path);
      return { path, branch, taskId };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/worktree/worktree.test.ts -t "resolves to the target"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/worktree.ts src/worktree/worktree.test.ts
git commit -m "feat(worktree): provision configured deps into the worktree on create"
```

---

## Task 4: Provision robustness — missing target is skipped, create() never throws

**Files:**
- Test: `src/worktree/worktree.test.ts` (behavior already implemented in Task 2's `provisionWorktree`)

- [ ] **Step 1: Write the failing test**

```ts
it("provision: a missing target is skipped — no dangling link, create() does not throw", async () => {
  const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["nope", "deps"] });
  mkdirSync(join(repoRoot, "deps"));
  writeFileSync(join(repoRoot, "deps", "dep.txt"), "ok\n");
  const wt = await m.create("t-missing", "main"); // must resolve, not reject
  expect(existsSync(join(wt.path, "nope"))).toBe(false);          // missing target -> no link
  expect(readFileSync(join(wt.path, "deps", "dep.txt"), "utf8")).toBe("ok\n"); // present target -> linked
});
```

- [ ] **Step 2: Run it to verify it passes (behavior already present)**

Run: `npx vitest run src/worktree/worktree.test.ts -t "missing target is skipped"`
Expected: PASS — `provisionWorktree` (Task 2) already `continue`s on a missing target and never throws. If it FAILS, the missing-target guard in `provisionWorktree` is wrong — fix it there so a missing target neither links nor throws.

- [ ] **Step 3: Commit**

```bash
git add src/worktree/worktree.test.ts
git commit -m "test(worktree): missing provision target is skipped, create() does not throw"
```

---

## Task 5: Teardown safety — target survives `teardown()`

**Files:**
- Modify: `src/worktree/worktree.ts` (`teardown()` — deprovision before `worktreeRemove`)
- Test: `src/worktree/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("teardown: unlinks the provisioned link but the target dir + contents survive", async () => {
  mkdirSync(join(repoRoot, "deps"));
  writeFileSync(join(repoRoot, "deps", "dep.txt"), "keep\n");
  const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });
  const wt = await m.create("t-td", "main");
  expect(existsSync(join(wt.path, "deps", "dep.txt"))).toBe(true);

  await m.teardown(wt);

  // The REAL target dir + its sentinel must be intact after the worktree removal.
  expect(existsSync(join(repoRoot, "deps", "dep.txt"))).toBe(true);
  expect(readFileSync(join(repoRoot, "deps", "dep.txt"), "utf8")).toBe("keep\n");
});
```

- [ ] **Step 2: Run it to verify it fails (or is at risk)**

Run: `npx vitest run src/worktree/worktree.test.ts -t "target dir + contents survive"`
Expected: FAIL or FLAKY on the current code path — `teardown()` calls `mainGit.worktreeRemove(wt.path)` on a worktree still holding the junction/symlink; on some platforms the recursive removal traverses the link and deletes the target sentinel. (Even where it passes today, the fix makes it deterministic.)

- [ ] **Step 3: Deprovision before removal in `teardown()`**

Change `teardown()` from:

```ts
    async teardown(wt: Worktree): Promise<void> {
      await mainGit.worktreeRemove(wt.path);
    },
```

to:

```ts
    async teardown(wt: Worktree): Promise<void> {
      // Unlink provisioned links FIRST: a leaked junction + `git worktree remove`
      // (recursive) could otherwise traverse into the clone's real deps.
      await deprovisionWorktree(wt.path);
      await mainGit.worktreeRemove(wt.path);
    },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/worktree/worktree.test.ts -t "target dir + contents survive"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worktree/worktree.ts src/worktree/worktree.test.ts
git commit -m "fix(worktree): unlink provisioned links before teardown removal (target-survives safety)"
```

---

## Task 6: Stale-cleanup safety — re-queued task id does not delete the target

**Files:**
- Modify: `src/worktree/worktree.ts` (`create()` re-queue cleanup — deprovision before the recursive cleanup)
- Test: `src/worktree/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("create re-queue: cleaning a stale worktree with a provisioned link does not delete the target", async () => {
  mkdirSync(join(repoRoot, "deps"));
  writeFileSync(join(repoRoot, "deps", "dep.txt"), "keep\n");
  const m = createWorktreeManager(repoRoot, worktreesDir, { provision: ["deps"] });

  const wt1 = await m.create("t-req", "main");
  expect(existsSync(join(wt1.path, "deps", "dep.txt"))).toBe(true);

  // Re-claim the SAME task id (rate-limit / retry / re-queue). The stale-cleanup
  // in create() runs on the existing worktree that still holds the link.
  const wt2 = await m.create("t-req", "main");
  expect(existsSync(join(wt2.path, "deps", "dep.txt"))).toBe(true);

  // The real target must be intact after the stale-cleanup's recursive delete.
  expect(readFileSync(join(repoRoot, "deps", "dep.txt"), "utf8")).toBe("keep\n");
});
```

- [ ] **Step 2: Run it to verify it fails (or is at risk)**

Run: `npx vitest run src/worktree/worktree.test.ts -t "does not delete the target"`
Expected: FAIL or FLAKY — the re-queue cleanup does `git worktree remove --force` + `rm(path, {recursive:true})` on a dir still holding the junction; recursive removal can traverse into `repoRoot/deps` and delete `dep.txt`.

- [ ] **Step 3: Deprovision at the top of the re-queue cleanup**

In `create()`, the re-queue cleanup currently starts with `git worktree prune`:

```ts
      await runNative("git", ["worktree", "prune"], { cwd: mainRepoRoot });
      await runNative("git", ["worktree", "remove", "--force", "--", path], { cwd: mainRepoRoot });
```

Insert a deprovision call as the FIRST line of the cleanup, before `prune`:

```ts
      // Unlink any provisioned links from a prior attempt BEFORE the recursive
      // cleanup below (`worktree remove --force` and `rm -rf`), so a stale
      // junction can never let those deletes reach the clone's real deps.
      await deprovisionWorktree(path);
      await runNative("git", ["worktree", "prune"], { cwd: mainRepoRoot });
      await runNative("git", ["worktree", "remove", "--force", "--", path], { cwd: mainRepoRoot });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/worktree/worktree.test.ts -t "does not delete the target"`
Expected: PASS.

- [ ] **Step 5: Full worktree + config suite + typecheck**

Run: `npx vitest run src/worktree/worktree.test.ts src/config/config.test.ts`
Expected: PASS (all).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/worktree/worktree.ts src/worktree/worktree.test.ts
git commit -m "fix(worktree): deprovision before re-queue stale-cleanup (target-survives safety)"
```

---

## Task 7: Wire config into the composition root

**Files:**
- Modify: `src/index.ts:168` (pass provision + log into the manager)

`src/index.ts` is untested glue by design (gotcha `[conductor/wiring]`) — no test; `npm run typecheck` + the full suite cover it.

- [ ] **Step 1: Change the manager construction**

At `src/index.ts:168`, change:

```ts
  const worktree = createWorktreeManager(repoRoot, worktreesDir);
```

to:

```ts
  const worktree = createWorktreeManager(repoRoot, worktreesDir, {
    provision: cfg.worktree.provision,
    log,
  });
```

(`log` is defined at line ~162, `cfg` at ~160 — both in scope here.)

- [ ] **Step 2: Typecheck + full test suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run` (heavy suites: add `--pool=forks --poolOptions.forks.singleFork=true` if needed)
Expected: all green (previous total + the new provision/config tests).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): wire worktree.provision + logger into the worktree manager"
```

---

## Task 8 — CODE-COMPLETE GATE (not a code edit)

- [ ] **Independent codex GPT-5.5 review of the whole diff** (Windows, inline diff). Build `prompt + git diff` to a file, then:

```bash
cat <promptfile> | codex exec -m gpt-5.5 -c model_reasoning_effort="high" -c approval_policy="never" -s read-only -C D:/Projects/autodev-harness --skip-git-repo-check -
```

Focus the critic on: the teardown/stale-cleanup **safety invariant** (can any path recursively delete a provisioned target? does `removeLinkOnly` ever touch the target? Windows-junction behavior of `unlink`/`rmdir`), the config refine (does `..`/absolute truly get rejected cross-platform), and backward compat (empty provision == prior behavior).

- [ ] **Fix every finding with a regression test; re-critic each fix.** Never self-certify. Only when the re-critic is clean does the ops task run.

---

## Task 9 — OPS: setup runbook + live proof on a woodev clone (operator-observed, not TDD)

Not a code edit — an operational checklist. Do NOT touch the live `D:\Projects\woodev_framework`.

- [ ] **Clone** `woodev_framework` to a disposable dir (e.g. `d:/projects/woodev-harness-clone`).
- [ ] `composer install` in the clone (no lockfile → fresh resolution; acceptable).
- [ ] Copy `plugins-reference/` from the original working tree into the clone (gitignored but load-bearing — guard recipes read into it).
- [ ] `git checkout -b autodev/s15-proof` in the clone (conductor refuses non-`^autodev/` HEAD).
- [ ] Add `.autodev/` to the clone's `.git/info/exclude` (runtime churn must not dirty the tree — `[conductor/real-repo-run]`).
- [ ] Author `.autodev/config.yaml` in the clone:
  - `gate:\n  checkCommand: "composer check"`
  - `worktree:\n  provision: [vendor, plugins-reference]`
  - roles mirroring the PS loop (worker ladder `[opus, sonnet, haiku]`, critic `codex`/`gpt-5.5`/effort `high`, anti-drift `sonnet`)
  - `guards.testCommandTemplate` set to run phpunit on a guard test file (expect a Windows shim wrinkle `vendor/bin/phpunit` vs `phpunit.bat` + the whitespace-split tokenizer `[conductor/wiring]`; the run will confirm the exact string).
- [ ] Ensure `claude` + `codex` CLIs are on PATH.
- [ ] **Run a real task** (reuse a formulation from the clone's tracked `queue/done/`, or enqueue a simple contract task) through `node <harness>/dist/index.js` (built from the s15 branch) pointed at the clone.
- [ ] **Success criterion:** the gate executes `composer check` (phpcs + phpstan + phpunit) IN THE WORKTREE on the provisioned deps — not `php -l` — and the run reaches a green COMMIT or a correct escalate. Capture the digest + the gate-verdict as proof. The original woodev is untouched; the clone is burnable.

- [ ] **Record** any new operational surprises as gotchas (`docs/gotchas/`), per the session-end protocol.

---

## Self-Review

**Spec coverage:** §2 grounding → Task 9 config values; §3 seams → Tasks 3/5/6/7; §4 config surface → Task 1; §5a provision → Tasks 3/4; §5b teardown+stale safety → Tasks 5/6 (the two danger spots both covered); §6 error handling → Task 2 `safeLog` + Task 4 missing-target; §7 tests → Tasks 1–6 (all 8 spec test cases present: link-resolves T3, off-by-default T2, teardown-safety T5, stale-safety T6, missing-target T4, pre-existing-link — see note, cross-platform — junction/dir branch in T2 impl + platform-agnostic assertions, config-reject T1); §8 runbook → Task 9; §9 proof → Task 9; §10 out-of-scope → nothing built for it. **Gap:** the spec's "pre-existing non-link path is not clobbered" case (§5a) is implemented in Task 2 (`existsSync(link)` skip) but has no dedicated test — acceptable (low-risk, covered by the guard); add a test in Task 4 if the critic asks.

**Placeholder scan:** none — every code step shows full code; every command shows expected output.

**Type consistency:** `WorktreeManagerOptions.{provision,log}`, `Logger = (level,message)=>void`, `provisionWorktree`/`deprovisionWorktree`/`removeLinkOnly`/`isSafeProvisionEntry` names used consistently across Tasks 2–7; `cfg.worktree.provision` matches the Task 1 schema key.

## Related

- `docs/superpowers/specs/2026-07-02-p3-deps-provisioning-design.md` — the approved design.
- `docs/gotchas/harness-on-real-repo-prerequisites.md`, `docs/gotchas/conductor-wiring-deferred-limitations.md`, `docs/gotchas/never-throws-catch-block-logging.md`.
