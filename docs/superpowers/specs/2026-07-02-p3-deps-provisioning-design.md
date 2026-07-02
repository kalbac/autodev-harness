# P3 sub-project 1 — Real-use: deps-provisioning + live-gate on a woodev clone

> Design spec. Status: **APPROVED** (operator, s15, 2026-07-02).
> First slice of P3 (product phase). Scope chosen with the operator: close the gaps
> that block the harness from taking REAL tasks off the PowerShell autodev-loop, proven
> on a **clone** of `woodev_framework` (the most relevant real project; a clone so the
> live project is never at risk).

## 1. Problem & goal

The harness is live-proven on `aurora` but only with a **dependency-free gate** (`php -l`,
syntax only). A fresh `git worktree` checks out **tracked files only**, so gitignored
dependency dirs (`vendor/`, `plugins-reference/`, `node_modules/`) are absent — any real
gate command (`composer check` → phpcs + phpstan + phpunit) fatals in the worktree
(`Failed to open vendor/autoload.php`). The critic therefore escalates any task needing
real test verification. **This is the blocker to real-use:** the gate is too weak to hold
real work, so everything escalates.

**Goal:** graduate the gate `php -l → composer check` by provisioning the configured
dependency dirs into each per-task worktree (Finding #1), and prove a real `woodev_framework`
task end-to-end on a clone with the real test gate actually executing.

**Non-goal (this slice):** the serving/packaging story ([ui/serve-uidir-reporoot]) — a
separate follow-up sub-project. See §9.

## 2. Grounding facts (recon, 2026-07-02)

From read-only recon of `D:\Projects\woodev_framework` (the live project — never modified):

- **Dep dirs a fresh clone/worktree LACKS (gitignored):** `vendor/` (required — gate calls
  `vendor/bin/{phpcs,phpstan,phpunit}`); **`plugins-reference/` (gitignored but LOAD-BEARING** —
  contract-guard recipe `file` fields and 8 guard tests read into it; a fresh clone lacks it →
  mutation-check + guard tests break); `node_modules/` (only for tasks touching React `src/*`;
  **not in the gate**). `composer.lock` is untracked → `composer install` resolves fresh
  (works; not byte-reproducible).
- **The real gate command:** `composer check` = `phpcs` + `phpstan analyse --memory-limit=2G`
  + `phpunit --testsuite=Unit`. Unit tests use Brain Monkey/Mockery — **no WordPress, no DB**.
  So the gate is self-contained (no Docker/wp-env needed).
- **No `.autodev/config.yaml` exists** — the PS loop's config is hard-coded in
  `tools/autodev/_common.ps1 :: Get-AutodevConfig`. The TS harness needs its own
  `.autodev/config.yaml` authored for the clone. Values to mirror: worker ladder
  `opus→sonnet→haiku` (contract tasks pinned to opus), critic `codex gpt-5.5`/effort `high`,
  anti-drift `sonnet`, `AllowedBranchPattern ^autodev/`.
- The blackboard (`GOAL.md`, `INVARIANTS.md`, `GUARDS.md`, `tests/unit/Contract/recipes/*.recipe.json`,
  `queue/`) **is git-tracked** → arrives with the clone. GUARDS.md columns:
  `contract_id | contract_value | guard_test | recipe | mutation_verified | blessed_by | date`
  (6 blessed rows; the harness guard parser was built against this real format in s05).

## 3. Code-side seams (verified)

- `src/config/schema.ts` — `HarnessConfigSchema` is root-`.strict()`. New `worktree` block added here.
- `src/worktree/worktree.ts` — `createWorktreeManager(mainRepoRoot, worktreesDir)`:
  - `create()` does `git worktree add` (line ~75) then returns `{path, branch, taskId}`.
    Provisioning hooks in **after** `worktreeAdd`. It also has a re-queue stale-cleanup block
    (lines ~64–73) that does `rm(path, {recursive:true, force:true})` — a second danger spot (§5).
  - `teardown()` calls `mainGit.worktreeRemove(wt.path)` (line ~89). Unlink hooks in **before** it.
- `src/index.ts:168` — `createWorktreeManager(repoRoot, worktreesDir)` composition root; extend
  to pass the provision config.
- Gate runs in the worktree: `src/index.ts:248-253` `runCheck` executes `cfg.gate.checkCommand`
  via `runNative(c, a, { cwd: wt.path })`; guard tests + `mutationCheck` also run in `wt.path`;
  `loadGuardPairsFrom(wt.path)` reads recipes whose `file` fields point into `plugins-reference/`.
  This confirms provisioning `vendor` + `plugins-reference` into `wt.path` is exactly what the
  gate needs. Wiring: `conductor.ts:181` (`create`), `:347` (`runGate`), `:447` (`teardown`).

## 4. Config surface

New block in `HarnessConfigSchema` (`.strict()` root):

```yaml
worktree:
  provision: [vendor, plugins-reference]   # node_modules optional; not in the gate
```

```ts
worktree: z
  .object({ provision: z.array(z.string()).default([]) })
  .default({ provision: [] }),
```

Each entry is a **relative path within repoRoot**; a `superRefine` (or per-item check)
rejects absolute paths and any segment containing `..` (a traversal would let link/unlink
escape repoRoot or the worktree). Empty list = provisioning off — **full backward compat**:
aurora and the parity fixture set no `worktree.provision`, so their behavior is unchanged.

## 5. Mechanism

### 5a. Provision (in `create()`, after `worktreeAdd`)

For each configured `p`: `target = join(repoRoot, p)` (absolute — a Windows junction requires
an absolute target), `link = join(wt.path, p)`.

- `target` missing on disk → **loud warn + skip** (do not create a dangling link; the gate
  will then fail honestly — that IS the signal).
- `link` already exists and is not our link → skip + warn (never clobber checked-out content).
- Else create the parent dir if `p` is nested, then
  `fs.symlink(target, link, type)` with `type = process.platform === "win32" ? "junction" : "dir"`.

Provisioning is **best-effort and NEVER throws** — a throw here would abort the whole task loop.
Wrap in try/catch, log via a `safeLog` wrapper (gotcha `[ts/fail-closed]`: the catch-block
logger must itself be guarded).

Because provisioned dirs are gitignored in the clone (`.gitignore` is tracked → checked out
into the worktree), they never appear in `git diff`/the dirty-file fence and are never
committed, so `mergeAfterGate` (main-tree porcelain check) stays clean.

### 5b. Teardown & stale-cleanup safety — the critical invariant

> **INVARIANT: teardown NEVER recursively deletes a provisioned target; it only `unlink`s the
> links themselves.** A leaked junction + `rm -rf`/`git worktree remove --force` could traverse
> into the clone's REAL `vendor`/`plugins-reference` and destroy it.

- **`teardown()`:** for each configured `p`, `lstat(link)`; if it is a symlink/junction
  (`isSymbolicLink()` is true for both dir-symlinks and Windows junctions) → `fs.unlink(link)`
  (removes the link, not the target; fall back to `fs.rmdir(link)` only if a platform quirk
  needs it). If it is a real directory (anomaly) → skip + warn, do NOT delete. **Then**
  `mainGit.worktreeRemove(wt.path)`. Order is mandatory. Wrap each unlink in try/catch so one
  failure doesn't leave the rest linked.
- **Second danger spot — `create()` re-queue stale-cleanup:** before the existing
  `rm(path, {recursive:true, force:true})` on a stale worktree path, **explicitly unlink any
  provisioned links** at that path. Do not rely on Node's version-specific behavior for
  recursive removal across junctions — unlink them first.

## 6. Error handling

Provisioning is fail-closed-neutral: never aborts the loop, logs loudly. Missing target →
warn (the gate delivers the real failure). Teardown unlink is per-link try/catch. A provision
config with `..`/absolute path fails at config-load (`.strict()` + refine), before any run.

## 7. Testing plan (TDD, no commit until gated)

New tests in `src/worktree/worktree.test.ts` (+ config tests in `src/config/config.test.ts`):

1. `create()` links configured dirs; the link resolves to the target (write a file into
   `repoRoot/<dir>` → visible through `wt.path/<dir>`).
2. provisioning **off by default** (empty list) → behavior identical to today (regression pin).
3. **Safety — teardown:** put a sentinel file in the target dir, provision, teardown; assert the
   sentinel + target dir still exist (target not deleted).
4. **Safety — stale-cleanup:** simulate a re-queued task id whose stale worktree holds a
   junction/symlink to a target with a sentinel; `create()` again; assert the sentinel survives.
5. missing target → warn + skip, `create()` does not throw, no dangling link created.
6. pre-existing non-link at `link` path → not clobbered.
7. cross-platform: the test detects `win32` (junction) vs POSIX (dir-symlink); `lstat().isSymbolicLink()`
   holds for both.
8. config: a `provision` entry with `..` or an absolute path → config-load rejects it.

Run `npm run typecheck` (src+test) after parallel subagents (gotcha `[ts/zod]`).

## 8. Setup runbook (ops — documented, executed at proof time)

Clone `woodev_framework` → a disposable dir (e.g. `d:/projects/woodev-harness-clone`):
1. `composer install` (no lockfile → fresh resolution; acceptable).
2. Copy `plugins-reference/` from the original working tree (gitignored, load-bearing).
3. Checkout an `autodev/…` branch (the conductor refuses non-`^autodev/` HEAD).
4. Add `.autodev/` to `.git/info/exclude` (its runtime churn must not dirty the tree —
   gotcha `[conductor/real-repo-run]`).
5. Author `.autodev/config.yaml` for the TS schema: `gate.checkCommand: "composer check"`,
   `worktree.provision: [vendor, plugins-reference]`, roles mirroring the PS config. Also set
   `guards.testCommandTemplate` so the **mutation-check path** (`guardStillRed`) runs phpunit on
   a guard test file — default `{testFile}` alone is not a command. Expect a Windows shim wrinkle
   (`vendor/bin/phpunit` vs `phpunit.bat`) + the whitespace-split tokenizer (`[conductor/wiring]`,
   no spaces in the path); the live proof will confirm the exact string (as s09/s12 iterations did).
6. Ensure `claude` + `codex` CLIs are available (worker + critic).

The original `woodev_framework` is never touched; the clone is burnable.

## 9. Live proof & success criterion

Run a real `woodev_framework` task end-to-end on the clone (reuse a formulation from the
tracked `queue/done/`, or a simple contract task) → worker → **`composer check` executes in
the worktree on the provisioned deps** → codex critic → green COMMIT; **or** a correct
escalate on a contract zone. **Success = the gate actually ran phpcs + phpstan + phpunit
(not `php -l`)**, proving graduation on a real repo. Original woodev untouched.

## 10. Out of scope (deliberate)

- **Serving story** ([ui/serve-uidir-reporoot]) — the dashboard for an external project;
  orthogonal (observation, not the loop). Next sub-project.
- **node_modules for JS tasks** — not in the gate; add when a React task is taken.
- **Parallel write-through** to a shared `vendor` — the loop is currently serial; documented
  as a known limitation (unit tests are almost read-only; acceptable for now).

## 11. Discipline

Code (enforcement-adjacent): sonnet-5 implementer (TDD, no commit) → controller spec-check →
independent codex GPT-5.5 gate → fix + regression test → re-critic every fix. Never self-certify.
Commit per module on an `autodev/s15-*` branch; the gated merge to `main` needs operator OK +
green CI. Ops setup + the live proof are operator-run/observed.

## Related

- `docs/gotchas/harness-on-real-repo-prerequisites.md` — the three real-repo prerequisites (`[conductor/real-repo-run]`).
- `docs/superpowers/donor-extraction/decision-matrix.md` — Finding #1 lives under axis 4 (worker isolation).
- `src/worktree/worktree.ts`, `src/config/schema.ts`, `src/index.ts` — the code seams.
- `docs/CURRENT-STATE.md` — NEXT ACTIONS (s15), P1-hardening Finding #1.
