# GOTCHAS — Autodev Harness

> Index of mistakes-to-avoid. Each entry → atomic detail file in `gotchas/{slug}.md`.
> Scan the relevant tags before starting related work.
> Count: 15.

| Tag | Gotcha | Detail |
|-----|--------|--------|
| `[ts/test-hang]` | An unterminated async loop with no-op (microtask) deps starves vitest's `setTimeout` timeout → the run HANGS uncatchably (process-killed at 5 min, no per-test failure), not a timeout. Ensure `run()`-style tests terminate (`maxIterations`/advancing clock). Also: a new foreground shell command KILLS the running background one — don't `echo` while waiting. | `gotchas/vitest-microtask-starvation-hang.md` |
| `[ts/typecheck-scope]` | An emit-scoped `tsconfig` (`rootDir: src`, `include: ["src/**"]`) silently EXCLUDES the top-level `test/**` tree from `tsc` → `npm run typecheck` is vacuously green there (vitest runs but doesn't typecheck). Add a `noEmit` `tsconfig.typecheck.json` (`rootDir: "."`, include src+test). | `gotchas/tsconfig-typecheck-skips-test-dir.md` |
| `[api/413-teardown]` | Returning HTTP 413 for an oversized body by calling `req.destroy()` BEFORE the response flushes = client sees a socket reset, not 413. Stop appending + reject in the reader; write 413 + `connection: close` in the handler; destroy the socket on `res` `finish`. | `gotchas/http-413-destroy-before-flush-resets-client.md` |
| `[test/vacuous-assert]` | A test can be green while proving nothing: (1) driving BOTH arms of an OR so either could pass it, (2) asserting an always-present label (`stray:`/`forbidden:`) instead of the value. Isolate one cause per test; assert the specific value. | `gotchas/vacuous-assertions-and-or-arm-isolation.md` |
| `[conductor/wiring]` | s07 composition-root deferred limitations: `zonesTouchedInDiff` reads main-root INVARIANTS (worktree-only zone edits caught by constitution/dirty-file instead); gate command strings are whitespace-split, not quote-aware (no spaces/quotes in commands or test paths — backlog a shell runner); `index.ts` is untested glue by design. | `gotchas/conductor-wiring-deferred-limitations.md` |
| `[ts/fail-closed]` | A "never-throws"/best-effort module must guard its **catch-block** logger and `env()` calls too — a throwing `deps.log` inside a `catch` re-throws the fail-closed path. Use a `safeLog` wrapper; test a throwing logger + throwing primary dep together. | `gotchas/never-throws-catch-block-logging.md` |
| `[ts/zod]` | zod `.optional()` + `exactOptionalPropertyTypes` types a field `\| undefined` — incompatible with a hand-written `x?: T`; derive types via `z.infer`. Vitest doesn't typecheck, so run `npm run typecheck` after parallel subagents. | `gotchas/zod-optional-exactoptional-derive-types.md` |
| `[ao/ui]` | The "AO chat-scroll bug" is a phantom — AO has no chat UI (tmux terminal, `scrollback:0`). Nothing to fix. | `gotchas/ao-chat-scroll-bug-is-a-phantom.md` |
| `[donor/openhands]` | OpenHands' real agent code lives in `software-agent-sdk`, not the main repo — study the SDK clone. | `gotchas/openhands-real-code-is-in-software-agent-sdk.md` |
| `[critic/codex]` | `codex exec` sandbox can't spawn subprocesses on Windows (`CreateProcessAsUserW failed: 5`) — embed the diff inline in the prompt and it reviews fine. | `gotchas/codex-exec-windows-sandbox-review-inline-diff.md` |
| `[critic/codex]` | `critic-verdict.schema.json` is not copied to `dist/` by `tsc` — the critic's `--output-schema` path breaks from a compiled build (works from source). Dist-copy deferred to Task 29. | `gotchas/critic-schema-json-not-copied-to-dist.md` |
| `[node/stdin-epipe]` | Writing `child.stdin` in `runNative` with no `'error'` listener → a child that closes its read end fast (fast-exiting `git` etc.) makes `stdin.end()` raise an UNHANDLED EPIPE that CRASHES the run. Flaky (raced: only ubuntu/node20 in s08 CI). Fix = swallowing `'error'` handler; child stdout/stderr/exit captured separately. | `gotchas/child-stdin-epipe-unhandled.md` |
| `[conductor/worker-report]` | Per-task worktree (divergence #1): the worker writes `worker-report.md` into the worktree cwd → dirty-file fence flags it STRAY → every task ESCALATEs before the gate, and the conductor can't find the report in runtimeDir. Fix = `harvestWorkerReport` relocates it worktree→runtimeDir before status-read+fence; unlink stale dest first (retry/re-claim carry-over). | `gotchas/worker-report-harvest-worktree-fence.md` |
| `[node/win-cmd-spawn]` | `node:child_process.spawn("codex")` → ENOENT on Windows for a PATH command that's a `.cmd` shim (npm-global), and node22 blocks `.cmd` without a shell (CVE-2024-27980). `claude.exe` works, `codex.cmd` doesn't. Fix = spawn via `cross-spawn` (PATH+PATHEXT + cmd.exe w/ verbatim args); POSIX passthrough. | `gotchas/runnative-windows-cmd-shim-spawn.md` |
| `[conductor/real-repo-run]` | Running on a REAL repo surfaces 3 prereqs the fixture never did: (1) fresh worktree has NO gitignored deps (vendor/node_modules) → use a dependency-free gate (`php -l`) or provision deps; (2) main tree must be CLEAN or `mergeAfterGate` throws; (3) `.autodev/` must be git-excluded or its runtime churn dirties the tree → merge throws. Plus: branch must match `^autodev/`. | `gotchas/harness-on-real-repo-prerequisites.md` |

## Anticipated tag namespaces

- `[fork/*]` — fork-hygiene / upstream-merge pitfalls
- `[ao/*]` — AO daemon/CLI behaviours
- `[electron/*]` — AO desktop UI internals
- `[critic/*]` — critic-gate wiring pitfalls
