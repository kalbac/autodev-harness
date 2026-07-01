# Gotcha — running the harness on a REAL repo: three operational prerequisites

**Tag:** `[conductor/real-repo-run]` · **Found:** s09 (2026-07-02), first live build-step-9 run. These are operational (not code bugs) — they bite the first real recipe.

Pointing `src/index.ts` at a real project (`cd <repo> && node <harness>/dist/index.js --once`) surfaced three prerequisites the fixture/parity harness never exercised:

## 1. A fresh git worktree has NO gitignored dependencies

`git worktree add` checks out **tracked files only**. `vendor/`, `node_modules/`, `.env`, `database/*.sqlite` are gitignored → **absent** from the worktree. So a gate `checkCommand` that needs installed deps (`composer test`, `php artisan test`, `vendor/bin/pint`, `npm test`) **fatals in the worktree** (`php artisan --version` → "Failed to open vendor/autoload.php") → gate never green → never COMMIT.
- **Workaround for a first proof:** a **dependency-free** gate — `php -l <file>` (PHP syntax), `node --check <file.js>` (JS syntax, NOT TS). Proves the plumbing without deps.
- **Real fix (deferred, Finding #1):** a harness feature to provision (symlink/junction) configured dirs into each worktree before the gate, so real test gates can run.

## 2. The main working tree must be CLEAN or `mergeAfterGate` throws

`worktree.mergeAfterGate` does a raw `git status --porcelain` on the main repo and **throws on any dirt** (after the worktree commit → hard crash). Uncommitted tool files (`.claude/settings.json`, `.serena/project.yml`, `.playwright-mcp/`) are enough. Commit/stash them, or (for a disposable sandbox) add them to `.git/info/exclude`.

## 3. `.autodev/` MUST be invisible to git in the target repo

During a run the harness churns `.autodev/{queue,runtime,digest.md,escalations}`. `mergeAfterGate`'s porcelain check has **no ignore list** (unlike the dirty-file fence's `DirtyFenceIgnore`), so if `.autodev/` is tracked/untracked-visible it **dirties the tree → merge throws**. Add `.autodev/` to the target repo's `.gitignore` (or `.git/info/exclude`). The harness reads config/queue via fs, not git, so exclusion is safe.

## Preflight reminders (from the code)

- The conductor **refuses to run unless the branch matches `^autodev/`** (never `main`). Checkout an `autodev/...` branch first.
- Gate command strings are **whitespace-split, not quote-aware** (`[conductor/wiring]`) — no spaces inside a path/arg (`php -l server/app/X.php` is fine; a path with a space is not).

## Related
- `docs/gotchas/conductor-wiring-deferred-limitations.md` — the whitespace-split + main-root-invariants limits.
- `docs/gotchas/worker-report-harvest-worktree-fence.md` — the worktree/report fence fix from the same run.
