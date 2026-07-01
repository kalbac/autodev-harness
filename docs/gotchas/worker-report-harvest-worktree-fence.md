# Gotcha — the worker's `worker-report.md` trips the dirty-file fence (worktree divergence)

**Tag:** `[conductor/worker-report]` · **Found:** s09 (2026-07-02), first live build-step-9 run on `aurora`. Fixed in `src/worker/report.ts` + `conductor.ts` (`ded192e`).

## The trap

We run the worker inside a **per-task git worktree** (cwd = worktree — divergence #1 from the PS oracle, which runs the worker in the main tree). The worker prompt (`src/worker/prompt.ts`) tells `claude` to "always write `worker-report.md`" but gives **no path**, so the worker writes it into the **worktree root**. Two consequences, both fatal for a real run:

1. The **DIRTY-FILE FENCE** compares the worktree's changed files against `task.file_set`. `worker-report.md` is not in `file_set` → flagged as **stray** → the conductor ESCALATEs (`dirty-file`) **before the gate**. No task can ever reach COMMIT.
2. The conductor reads status via `repo.readRuntimeFile(id, "worker-report.md")` from `<repoRoot>/.autodev/runtime/<id>/` — where the report never lands → status parses as `""`, and the critic gets no report.

The PS oracle never hit this because its worker runs in the main tree and writes to `runtime/<id>/`, which is in `DirtyFenceIgnore`. Adding worktrees moved the report into fence range.

## The fix

`harvestWorkerReport(worktreePath, runtimeDir)` relocates `<worktree>/worker-report.md` → `<runtimeDir>/worker-report.md` **after the worker runs and before the status read + fence** (a `ConductorDep`; real impl in `index.ts`). Matches parity spec §6 (the report belongs at `runtime/<id>/worker-report.md`).

## Subtleties the codex gate caught (don't regress)

- **Stale carry-over:** `runtimeDir` persists across critic-retry rounds AND re-claims of the same id. If a later round writes no report, a stale prior `status:` would be re-read. `harvestWorkerReport` must **unlink the dest FIRST**, every call, so the runtime report reflects only the current round.
- **EXDEV fallback must be atomic-ish:** on a cross-device `rename`, `copyFile`+`rm(src)`; if `rm(src)` fails after a successful copy, roll back the dest — never leave both a stale dest and a live worktree source (which the fence would then flag).

## Lesson (general)

Any worker **artifact written to the worktree cwd** (report, heartbeat, scratch) must be harvested out of the tree before the dirty-file fence, or excused via `DirtyFenceIgnore`. Prompts that name an output file without a path let the worker choose cwd.

## Related
- `docs/gotchas/conductor-wiring-deferred-limitations.md` — sibling composition-root limits.
- `docs/gotchas/harness-on-real-repo-prerequisites.md` — the other live-run prerequisites.
