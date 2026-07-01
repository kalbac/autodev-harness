# `[conductor/wiring]` — known limitations of the s07 composition root

**Tag:** `[conductor/wiring]`
**Seen:** s07 (index.ts composition root). Two codex findings were **deliberately
deferred with documentation** rather than fixed — record here so they are not
"rediscovered" as bugs and so the live-run hardening step (build step 9) picks
them up.

## 1. `zonesTouchedInDiff` reads INVARIANTS.md from the MAIN repo root, not the worktree
`ConductorDeps.zonesTouchedInDiff(diff)` receives only the diff string — the
conductor does **not** pass the worktree — so `index.ts` can only load contract
zones from `repoRoot`, not `wt.path`. Consequence: a worker that ADDS a new
contract zone by editing `INVARIANTS.md` inside its worktree won't have that
brand-new zone counted by the mislabel-detection `contractRisk` in the
critic-retry loop.
**Why it's acceptable:** editing `INVARIANTS.md` is itself a constitution-path
change → the gate's constitution check ESCALATEs regardless; and if
`INVARIANTS.md` is outside the task's `file_set` the dirty-file fence catches it
first. Existing zones (the common mislabel case) ARE in the main-root file, so
they are detected. A proper fix needs a `ConductorDeps` API change (pass the
worktree to `zonesTouchedInDiff`) — do it only if a real case demands it.

## 2. Gate command strings are whitespace-split, NOT shell/quote-aware
`index.ts` runs `cfg.gate.checkCommand`, each `success_command`, and
`cfg.guards.testCommandTemplate` via `splitCommand` = `cmd.trim().split(/\s+/)`
then `runNative(c, args)` (no shell). So **quoted args and paths containing
spaces break** (e.g. `--grep "contract zone"`, or a `{testFile}` with a space →
guard misjudged red/green). The PS loop ran these via `cmd /c` (a real shell).
**Why it's deferred:** these commands are operator-authored trusted config, and
simple token commands (`npm test`, `composer check`, `vitest run {testFile}`)
work. **Backlog:** a cross-platform shell-aware / quote-aware command runner
(then success_commands regain PS `cmd /c` parity). Until then: **keep gate/guard
commands to simple whitespace-separated tokens; no quoting; no spaces in test
paths.**

## 3. `src/index.ts` is untested by design
It is the production composition root — integration glue that spawns real
`claude`/`codex`/`git`, so it has **no automated test**. Every module it wires
has its own fake-injected unit tests; index.ts correctness rests on `typecheck`
+ the codex review of the wiring. First real validation is the parity harness
(Task 28, fakes) and the live run (build step 9).

## Related
- [[vitest-microtask-starvation-hang]]
- `src/index.ts`, `src/conductor/conductor.ts`
- parity spec §2 (conductor), §4 (gate).
