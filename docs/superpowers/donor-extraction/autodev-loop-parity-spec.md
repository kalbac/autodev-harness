# Autodev-Loop Parity Spec — PowerShell (AS-BUILT) → TypeScript port

> Reverse-engineered from the REAL code, not the design doc. Every claim below is
> anchored to `path:line` in the PowerShell source or a real file in the live
> blackboard. Where the code and `docs/reference/autodev-loop-runbook.md` (the
> 2026-06-04 design doc) diverge, **the code is authoritative** — divergences are
> called out explicitly in §11.
>
> Source studied in place (NOT cloned):
> - Code: `D:/Projects/woodev_framework/tools/autodev/*.ps1` (+ `critic-verdict.schema.json`)
> - Live blackboard: `D:/Projects/woodev_framework/.autodev/`
> - Design reference: `D:/Projects/autodev-harness/docs/reference/autodev-loop-runbook.md`
>
> All line numbers are as of the versions read on 2026-07-01 (`conductor.ps1` /
> `gate.ps1` / `invoke-critic.ps1` / `invoke-worker.ps1` / `_common.ps1` last
> modified 2026-06-26; `anti-drift.ps1` / `mutation-check.ps1` / `scheduler.ps1` /
> `watchdog.ps1` last modified 2026-06-11).

---

## 1. Module responsibilities

### `_common.ps1` (540 LOC) — shared config + pure helpers, dot-sourced by everything
No loop logic, no judgment calls. Owns: repo-root discovery, `Get-AutodevConfig`
(the single config object — paths, ladders, thresholds), directory bootstrap,
SHA256 helpers, logging (`Write-AutodevLog`, tees to console + `conductor.log`),
`INVARIANTS.md` JSON-block parsing, glob matching (`Test-GlobMatch` — `**` across
slashes, `*` within a segment), contract-zone touch detection (`Test-ZoneTouched`,
`Get-AutodevTouchedZoneIds`, `Get-AutodevZoneTouchedStrings`), branch-guard
predicates, the dirty-file fence's fingerprint machinery (`Get-AutodevFileFingerprints`,
`Get-AutodevWorkerTouchedFiles`, `Get-AutodevStrayChangedFiles`,
`Get-AutodevForbiddenTouches`), the task-file YAML-lite frontmatter parser
(`ConvertFrom-AutodevTask`), file-set disjointness (`Test-FileSetsDisjoint`), a
safe native-process runner (`Invoke-Native`, works around a PS 5.1 stderr-as-terminating-error
gotcha), git-diff helpers scoped to a task's `file_set`, `composer check` invocation,
and rate-limit string/exit-code sniffing (`Test-RateLimited`). Explicitly does NOT
set `Set-StrictMode`/`$ErrorActionPreference` (would leak into dot-sourcing callers).
ASCII-only by convention (`_common.ps1:10-13`) — CP1251 mis-decode of UTF-8 corrupts
the PS 5.1 parser.

### `conductor.ps1` (659 LOC) — the loop; zero LLM calls, zero judgment
Entry point. Per-iteration spine: claim → circuit-breaker → worker (with dirty-file
fence) → critic (bounded retry) → gate → commit/escalate/retry. Also owns branch
preflight, the outer `while(true)` loop with idle-sleep / rate-limit backoff /
`MaxSessionHours` wall-clock exit, and the anti-drift trigger every
`AntiDriftEveryCommits` commits. Ships its own `-SelfTest` (8 cases, pure — no
subprocesses) covering the circuit-breaker refund invariant, fail-closed commit
gating, the counter-increment guard, branch preflight, the dirty-file fence
(constitution-catch + boundary-safety + fingerprinting), and drift-escalation
routing.

### `gate.ps1` (403 LOC) — the machine lock
Given a diff (working tree, optionally scoped to a task's `file_set`), decides
`COMMIT | RETRY | ESCALATE`. Runs `composer check` (or a custom subcommand),
each of a task's `success_commands` (each must exit 0), constitution-path
detection (always ESCALATE), and per-contract-zone coverage: for every touched
zone, resolves which *enumerated contract values* are actually present in the
diff and requires a guard PER VALUE (`Select-AutodevGuardForValue`), falling back
to a zone-level guard (`Select-AutodevGuardForZone`) only when the zone was
touched via path/grep with no enumerated string in the diff. A guard must be
`mutation_verified: yes...`, `blessed_by` an operator (not `pending-operator`/empty),
AND still go RED when `mutation-check.ps1` is re-run live. Ships its own
`-SelfTest` (5 cases) proving the per-value coverage fix (a sibling value in the
same zone is NOT auto-covered by another value's guard).

### `invoke-critic.ps1` (249 LOC) — adversarial critic (codex GPT-5.5, read-only, fenced)
Given `runtime/<id>/diff.patch`, tiers to `none` (empty diff) or `expensive` (every
non-empty diff — there is deliberately no "cheap rubber-stamp" tier in `auto` mode).
Physically moves `worker-report.md` out of the repo tree for the duration of the
call (restored in `finally`) so the critic cannot read the worker's rationale;
combined with `codex exec -s read-only` this is a mechanical fence, not just an
instruction. Builds an adversarial prompt inline (diff embedded, not read from
disk by codex), calls `codex exec -m gpt-5.5 -c model_reasoning_effort=high
-s read-only --output-schema critic-verdict.schema.json -o <file>`, parses the
structured output (falling back to regex-extracting the last `{...}` blob from
combined stdout+stderr if `-o` wasn't written), and writes `verdict.json`. Exit
0 = clean, 3 = broken/uncertain (route to human), 4 = rate-limited (only reachable
when NO usable verdict was parsed — a parsed verdict always wins over rate-limit
heuristics, fixing a 2026-06-07 bug where a critic reading its own rate-limit-fix
docs falsely tripped the detector).

### `invoke-worker.ps1` (192 LOC) — disposable `claude -p` worker + model ladder
Builds the worker prompt (task body + prior critic feedback if this is a retry
round + fixed rules block), constructs the model ladder (contract-zone pin wins
over everything; else a declared `model:` starts a sub-ladder of cheaper-only
step-downs; else full ladder), and runs it through the watchdog
(`Start-WatchedProcess`). `-DryRun` builds the ladder + prompt without spawning
`claude`. Returns `{ Status; Model; RateLimited; TimedOut; ExitCode }` — the
conductor separately reads `worker-report.md` for the authoritative task status.

### `scheduler.ps1` (290 LOC) — the file-set lock
`Invoke-ClaimNextTask`: atomic `Move-Item pending/<id> → active/<id>`; a lost race
(another iteration already claimed it) is silently skipped, not an error. A
pending task is claimable only if (a) its `file_set` is disjoint from every
*active AND escalated* task's `file_set` (escalated tasks block like active ones
— an escalated task still "holds" its files) and (b) every id in its
`depends_on` has a matching file in `done/`. Ships `-ListClaimable` (dry-run
report) and `-SelfTest` (7-task synthetic scenario: overlap-block, escalated-block,
dependency-gate, dependency-satisfied).

### `watchdog.ps1` (228 LOC) — process-liveness kill switch
`Start-WatchedProcess`: spawns a native process with piped stdin, streams stdout/stderr
line-by-line via `Register-ObjectEvent` (bumping a shared "last activity" clock on
every line — NOT only on heartbeat-file touches, since models routinely forget to
touch the heartbeat during long silent reasoning phases). Liveness = newest of
(process stdout/stderr activity, heartbeat file mtime, newest file mtime under any
`-ActivityPaths`). Kills the whole process tree (`Stop-ProcessTree`, recursive via
`Win32_Process` WMI parent-lookup) on staleness `> StaleSeconds` or hard timeout
`> TimeoutSeconds`. Returns `{ ExitCode; TimedOut; RateLimited; Stdout; Stderr }`.

### `mutation-check.ps1` (131 LOC) — proves a guard is real
Given a `mutation-recipe.json` (`{ file, locator, canonical_value, mutated_value,
guard_test }`): snapshot original bytes → run `guard_test` (must be GREEN) →
literal-substring-replace `locator`'s `canonical_value` with `mutated_value` in
`file` → re-run `guard_test` (must go RED) → restore original bytes (also in a
`finally` backstop) → re-run `guard_test` (must be GREEN again). A guard that
stays GREEN under mutation is NOT protecting anything — FAIL, and the gate must
never treat it as coverage.

### `anti-drift.ps1` (119 LOC) — periodic intent-conformance check
Feeds a cheap Sonnet critic (1) the phase intent (regex-extracted "## Next action"
+ "## Stage map" sections from `docs-internal/platform-v2-program-tracker.md`)
and (2) the actual diffs of recent `done/`-task commits (`git diff SinceRef..HEAD`),
and asks it to judge ONE thing: does the work advance the stated intent, or has it
wandered while satisfying the letter of the tasks? Appends exactly one
`ON-TRACK:|DRIFT:|UNCERTAIN:`-prefixed line to `digest.md`, timestamped. An
unparseable or failed run degrades to `UNCERTAIN`, never to a false `ON-TRACK`.

### `escalate.ps1` (94 LOC) — human inbox writer + best-effort delivery
Always writes the durable `.autodev/escalations/<id>.md` artifact (structured:
what happened / decision / option A / option B / cost of being wrong / evidence).
Delivery is best-effort: if `AUTODEV_TELEGRAM_TOKEN`+`AUTODEV_TELEGRAM_CHAT` env
vars are set, POSTs directly to the Telegram Bot API; otherwise appends a
checkbox line to `escalations/_outbox.md` for a human/relay to pick up later.
Replies are explicitly documented as A/B structured choices only — free text is
recorded for context but never fed to a worker as an instruction (Telegram is
named as an injection surface).

---

## 2. The main loop (`conductor.ps1`) — exact step sequence

Entry (`conductor.ps1:585-659`):

1. **`-SelfTest`** short-circuits everything (line 585).
2. **Branch preflight** (line 589-594): `git rev-parse --abbrev-ref HEAD`; if it
   does not match `AllowedBranchPattern` (`^autodev/`), **exit 1** without doing
   anything. Never runs on `main`.
3. Outer `while (true)` (line 599):
   a. `MaxSessionHours` wall-clock cap (line 601-605) — graceful `break`, not a
      kill; checked at the TOP of every iteration, before spawning a worker.
   b. `Invoke-ConductorIteration` (below).
   c. Anti-drift trigger: increments `commitsSinceDrift` only via the explicit
      `$script:iterationCommitted` flag (never via `done/` file existence, which
      can false-increment on a re-queued task id — line 611). At
      `AntiDriftEveryCommits` (5) commits, runs `anti-drift.ps1 -SinceRef
      "HEAD~$window" -CommitsSinceLast $window`; a `DRIFT:`-prefixed verdict line
      escalates (type `drift`); `ON-TRACK`/`UNCERTAIN` only reach the digest.
   d. `-Once` / `-MaxIterations` early exit.
   e. Sleep: `RateLimitBackoffSeconds` (600s) if the iteration hit a 429 (worker
      OR critic), else `SleepSeconds` (default 30) if nothing was claimed. A 429
      iteration returns a non-null task, so without the explicit
      `iterationRateLimited` flag the idle-sleep branch would never fire and the
      loop would busy-loop on the same rate limit (line 649-657).

`Invoke-ConductorIteration` (`conductor.ps1:147-454`), per-task spine:

1. **CLAIM** (line 156-160): `scheduler.ps1` atomic claim; `$null` → iteration
   returns `$null` (idle).
2. **CIRCUIT BREAKER** (line 163-176): `attempts = Get-Attempts+1` (persisted at
   `runtime/<id>/attempts`); `> MaxAttempts` (3) → move to `quarantine/` + escalate
   type `poison`, **return** (no worker spawned).
3. **WORKER + dirty-file fence + CRITIC**, in a bounded `while(true)` retry loop
   (line 187-375):
   - Pre-worker fingerprint baseline of ALL currently-dirty raw paths (line 200) —
     content-hash keyed, not just path-set, so a worker editing an
     already-dirty out-of-scope file is still caught later.
   - **3. WORKER**: `invoke-worker.ps1 -Model $task.model -TouchesContractZone:$isContract`
     (skipped if `-AssumeWorkerDone`). `RATE_LIMITED` → `Restore-Attempt` (refund),
     move task back to `pending/`, **return** (external pause, not a failed
     attempt). `TIMED_OUT` → move to `pending/` for a fresh attempt, **return**
     (attempt NOT refunded — this is a genuine failure).
   - **4. WORKER-REPORT routing** (line 224-253): regex `^\s*status\s*[:=]\s*TOO_BIG`
     → quarantine + escalate type `blocked` reason `'task too big'`. `NEEDS_GUARD`
     → `escalated/` + type `needs-guard`. `BLOCKED` → `escalated/` + type `blocked`.
   - **4b. DIRTY-FILE FENCE** (line 255-285): recompute fingerprints, diff against
     baseline (`Get-AutodevWorkerTouchedFiles` — only NEW dirt this run), then
     `Get-AutodevStrayChangedFiles` (outside `file_set`, not under
     `DirtyFenceIgnore`) and `Get-AutodevForbiddenTouches` (matches
     `task.forbidden_paths`, honored even under `-AssumeWorkerDone`). Either
     non-empty → `escalated/` + type `dirty-file`, **return**.
   - **5. DIFF + CRITIC** (line 287-374): regenerate `diff.patch` authoritatively
     from the working tree (real runs leave the change UNCOMMITTED — the gate is
     the lock, not the worker). Optional `-ReuseVerdict` round-0 optimization:
     reuses a stored `clean` verdict only if its `diff_sha256` matches the current
     diff's hash. Otherwise runs `invoke-critic.ps1`. Exit 4 (rate-limited) →
     refund + backoff + `pending/`, **return**. `verdict=='clean'` → **break** to
     gate. Otherwise: `contractRisk = task.touches_contract_zone OR
     actualZonesTouched.Count>0 OR critic.broken_contracts non-empty` (line 350) —
     a mislabeled task cannot dodge this via frontmatter. `contractRisk OR round >=
     maxRounds OR -AssumeWorkerDone` → `escalated/` + type `disagreement`
     (verdict=broken) or `uncertain`, **return**. Else: write
     `critic-feedback.md`, `round++`, loop back to WORKER with a fresh agent.
4. **6. GATE** (line 377-381): `gate.ps1 -FileSet $task.file_set -SuccessCommands
   $task.success_commands`; reads `gate-verdict.json`.
5. **7. DECISION** (line 383-453):
   - `RETRY` (composer/success_command failed) → `pending/` for a fresh worker
     attempt, attempt **NOT** refunded (a real failure, so repeated RETRYs still
     trip the breaker — see divergence #4 below). **Never** left in `active/`.
   - `COMMIT`: re-checks the branch AT COMMIT TIME (HEAD can move mid-run — a
     second, independent check beyond the startup preflight, line 412-428); off-branch
     → `escalated/` + type `blocked`, **no commit**. On-branch: `git add` the
     `file_set` files only, `git commit -m "<kind>(autodev): <title>"` where
     `kind = task.type=='guard' ? 'test' : 'refactor'`; move to `done/`, append
     `<!-- committed: <hash> -->`; sets `$script:iterationCommitted = $true`.
   - Anything else (including malformed/empty decisions) is **fail-closed**:
     ESCALATE, type `constitution` if `constitution_touched` non-empty else
     `needs-guard`. `Move-Task` happens BEFORE the escalation artifact write so
     the task lands in `escalated/` even if the write throws.

---

## 3. Blackboard schema (real fields from real files)

### Task file frontmatter (`ConvertFrom-AutodevTask`, `_common.ps1:351-410`)
Simple YAML-lite: scalars + one level of `- item` lists, no external YAML dep.
Pre-initialized defaults (StrictMode-safe access even when a task omits them):

```
id, title, type
touches_contract_zone: false     writes_guard: false
model: null                      # optional: haiku | sonnet | opus (omit = full ladder)
success_commands: []             # shell commands; each MUST exit 0 to COMMIT
forbidden_paths: []              # globs the worker must NOT touch
max_rounds: null                 # per-task override of CriticRetryMax
file_set: []
body, path                       # populated by the parser, not frontmatter
```

Real files add more keys the generic parser still captures (as scalars/lists)
even though `_common.ps1` doesn't pre-declare them:
`phase`, `depends_on: [...]` (parsed separately by `Get-AutodevTaskDependencies`,
`scheduler.ps1:70-88`, tolerant of block-list / inline-array / absent forms),
`contract_zones_touched: [...]`, `needs_guard: yes|no`, `acceptance: [...]`
(free-text checklist, human/worker-facing only — NOT machine-enforced; contrast
with `success_commands` which IS gate-enforced). Real example
(`s7-t1-conductor-model-tiering.md:1-24`):

```yaml
---
id: s7-t1-conductor-model-tiering
title: Wire per-task worker model tiering (haiku/sonnet/opus) into the autodev conductor loop
phase: Autodev tooling — Fable 5 re-tiering (orchestrator prompt "After / housekeeping")
type: tooling
touches_contract_zone: false
writes_guard: false
file_set:
  - tools/autodev/_common.ps1
  - tools/autodev/invoke-worker.ps1
  - tools/autodev/conductor.ps1
  - docs-internal/fable5-autodev-orchestrator-prompt.md
depends_on: []
contract_zones_touched: []
needs_guard: no
acceptance:
  - "Task frontmatter supports optional `model: haiku|sonnet|opus`; ..."
  - ...
---
# Task
<body markdown>
```

A `done/` task file gets one line appended post-commit:
`<!-- committed: af28c89 -->` (`conductor.ps1:433`; real example
`s1-p1-pickup-selection.md:51`).

### `worker-report.md` (`runtime/<id>/worker-report.md`, written by the worker)
Frontmatter fields (real example `runtime/s1-p1-pickup-selection/worker-report.md:1-9`):
```yaml
---
task: <id>
status: DONE | TOO_BIG | NEEDS_GUARD | BLOCKED
files_touched: [ ... ]
contract_zones_touched: [ ... ]
writes_guard: true|false
needs_guard: yes|no
---
```
Body is free-form markdown (rationale, what was built, acceptance-status
checklist). The conductor parses ONLY the `status` line via regex
(`conductor.ps1:228,241`) — the rest is for the human/critic-fence, not machine-parsed.

### `verdict.json` (critic output, `invoke-critic.ps1:58-67`, schema in `critic-verdict.schema.json`)
```json
{ "verdict": "clean" | "broken" | "uncertain",
  "broken_contracts": [ { "zone": "...", "file": "...", "line": N, "evidence": "..." } ],
  "notes": "...", "confidence": 0.0-1.0,
  "diff_sha256": "<hex>" }
```
`additionalProperties: false`, all 4 of `verdict/broken_contracts/notes/confidence`
required by the JSON Schema passed to `codex exec --output-schema`. `diff_sha256`
is added by the PS wrapper (not part of the codex-facing schema) — it's the
`-ReuseVerdict` cache key.

### `gate-verdict.json` (`gate.ps1:322-331`, real example above)
```json
{ "task_id": "...", "composer_green": true, "success_green": true,
  "constitution_touched": [...],
  "zones_touched": [ { "id": "...", "auto_guardable": true, "guarded": true,
                        "guard_test": "...", "mutation_passed": true, "blessed": true,
                        "touched_strings": [...], "uncovered_strings": [...] } ],
  "decision": "COMMIT" | "RETRY" | "ESCALATE",
  "reasons": [...], "changed_files": [...] }
```
Empty `file_set` short-circuits to a fixed `ESCALATE` verdict BEFORE INVARIANTS/GUARDS
are even loaded (`gate.ps1:149-166`) — so a malformed task can't crash the gate
into a non-writing state.

### `mutation-recipe.json` (guard-writing task output, real example
`runtime/guard-yandex-contracts/mutation-recipe.json`)
```json
{ "zone_id": "...", "contract_id": "...", "file": "...", "locator": "<exact substring>",
  "canonical_value": "...", "mutated_value": "..._MUTATED_...", "guard_test": "tests/..." }
```
A wrapper file (`{ "task": "...", "note": "...", "recipes": [...] }`) can bundle
multiple recipes for one guard-writing task; `mutation-check.ps1` consumes one
recipe object at a time.

### `escalations/<id>.md` (`escalate.ps1:49-68`)
Fixed markdown template: `# ESCALATION {id} -- {reason}`, then bolded fields
`Task / Type / What happened / Decision you need to make / Option A / Option B /
Cost of being wrong`, an ` ```evidence``` ` fenced block, then a fixed "Reply: A/B"
footer. `Type` is a closed `ValidateSet`: `needs-guard | disagreement |
constitution | uncertain | poison | blocked | dirty-file | drift`.
`escalations/_outbox.md` is a flat checklist of one-liners
(`- [ ] [autodev escalation <id>] <type> :: <title> -- <decision> ... (file: escalations/<id>.md)`),
appended by `escalate.ps1:90` and later hand-annotated with `RESOLVED ...` prose
by the operator (see real `_outbox.md` — this becomes the durable decision log).

### `digest.md`
Free-running markdown log; the ONLY machine-written part is the anti-drift
one-liner (`anti-drift.ps1:112-115`):
`[yyyy-MM-dd HH:mm:ss] [anti-drift] (window: N commits) ON-TRACK:|DRIFT:|UNCERTAIN: <sentence>`.
Everything else under `## Autodev digest — ...` headings in the real file is
operator/assistant-authored narrative, not conductor output.

### `INVARIANTS.md` machine block (`_common.ps1:141-148` parses it)
A fenced ` ```json ``` ` block between `<!-- BEGIN MACHINE-INVARIANTS -->` /
`<!-- END MACHINE-INVARIANTS -->` markers — this is the ONLY machine-readable
part; surrounding prose is for humans. Real schema:
```json
{ "version": 1, "updated": "...",
  "contract_zones": [ { "id": "...", "why": "...", "auto_guardable": true|false,
                         "path_globs": [...], "grep_patterns": [...], "exact_strings": [...] } ],
  "constitution": { "why": "...", "path_globs": [...] } }
```

### `GUARDS.md` table (`gate.ps1:47-70` parses the markdown pipe-table)
7 columns: `contract_id | contract_value | guard_test | recipe | mutation_verified
| blessed_by | date`. `blessed_by: pending-operator` (or empty) means
mutation-proven but NOT yet autonomous (`Test-AutodevGuardBlessed`,
`gate.ps1:121-125`).

---

## 4. Machine gate (`gate.ps1`) — exact checks in order

`Invoke-AutodevGate` (`gate.ps1:135-339`):

0. **Empty file_set fast-path** (line 149-166): if no `-Range` and no `-FileSet`,
   write a fixed `ESCALATE` verdict and return — BEFORE loading INVARIANTS/GUARDS
   (so a missing/broken INVARIANTS.md can't prevent this from being written).
1. Scope resolution (line 172-188): `-Range` (a git ref range) > `-FileSet`
   (working tree vs HEAD, restricted to those paths — this is what the production
   conductor call uses, `conductor.ps1:378`) > whole working tree (fallback,
   self-test/manual use only). **Critical**: file_set-scoping was itself a bug
   fix (2026-06-06) — the whole-tree default let a PARKED task's uncommitted
   files contaminate another task's gate verdict (see divergence #7).
2. **`composer check`** (or `-SkipComposer`) — whole-tree always, regardless of
   scope (line 193-200): this validates the whole codebase compiles/passes, not
   a per-task question.
3. **`success_commands`** (line 202-215): each runs via `cmd /c` in the repo root;
   any non-zero exit sets `successGreen=false` and appends a reason. A failure
   here behaves exactly like a composer failure (→ RETRY, not ESCALATE).
4. **Constitution check** (line 217-224): any changed file matching
   `inv.constitution.path_globs` → always `ESCALATE`, regardless of everything else.
5. **Per-zone contract coverage** (line 226-307), for each zone touched
   (`Test-ZoneTouched` — path_glob OR grep_pattern OR exact_string match against
   the scoped diff):
   - Not `auto_guardable` → human-only, reason appended, zone recorded
     `guarded=false`.
   - `Get-AutodevZoneTouchedStrings` finds which of the zone's `exact_strings`
     literally appear in the +/- diff lines.
     - **Touched strings present** → PER-VALUE coverage: for EACH touched
       string, `Select-AutodevGuardForValue` requires a guard whose recipe's
       `canonical_value` equals THAT exact string. Any uncovered value fails the
       whole zone (does not fall through to zone-level). All covered → EVERY
       one of those guards must ALSO be `blessed` AND still-red-on-flip
       (`Test-AutodevGuardStillRed`, which live-runs `mutation-check.ps1
       -Quiet` per guard).
     - **No touched strings** (path/grep-only touch) → legacy fallback:
       `Select-AutodevGuardForZone` (recipe's `zone_id` matches) — a weaker
       proxy kept for sensitive-area edits that introduce no known contract
       literal.
6. **Decision** (line 309-320): `RETRY` if `!composerGreen || !successGreen`
   (checked FIRST, overrides everything else); else `ESCALATE` if constitution
   touched; else `ESCALATE` if ANY touched zone is `!auto_guardable ||
   !guarded || !mutation_passed || !blessed`; else `COMMIT`.

`gate.ps1` self-invokes with exit codes 0=COMMIT, 2=RETRY, 3=ESCALATE
(`gate.ps1:396-403`) — `conductor.ps1` reads the written `gate-verdict.json`
rather than trusting the exit code alone.

---

## 5. Critic invocation (`invoke-critic.ps1`) — exact mechanics

- Tier selection (`auto` mode): `diffLineCount==0` → `none` (pass-through clean,
  confidence 0.5); else `expensive` — no `cheap` tier is ever auto-selected
  (line 91-94). `cheap`/`none` remain explicit overrides for tests only.
- **Fencing** (line 108-114): if `worker-report.md` exists, `Move-Item` it to a
  temp path OUTSIDE the repo for the duration of the call, restored in `finally`
  even on error (line 201-204). Combined with `codex exec -s read-only`.
- **Exact command** (line 179-188):
  ```
  $prompt | codex exec `
      -m gpt-5.5 `
      -c 'model_reasoning_effort="high"' `
      -c 'approval_policy="never"' `
      -s read-only `
      -C <RepoRoot> `
      --skip-git-repo-check `
      --output-schema critic-verdict.schema.json `
      -o runtime/<id>/critic-last-message.json `
      -  *> runtime/<id>/critic-output.txt
  ```
  Prompt is piped via stdin (`-` as the last positional arg). `*> file` captures
  ALL streams merged, worked around PS 5.1's stderr-as-terminating-error
  behavior under `Stop` (temporarily relaxed to `Continue`, line 177).
- **Prompt structure** (line 119-164): adversarial framing ("default assumption:
  this diff BREAKS a contract — prove it"), explicit fencing instruction
  (told NOT to read `worker-report.md` or the commit message, reinforcing the
  physical move), ordered checklist (1. zone touches, 2. guard-per-touch,
  3. fabricated-proof detection — a test edited to match a changed contract is
  itself BROKEN, 4. logic/regression risk independent of contracts), diff embedded
  inline (not read from disk by codex — avoids a second fencing surface).
- **Verdict parsing** (line 216-236): the `-o` file is read first; a tolerant
  regex (`(?s)\{.*\}`) extracts the JSON object even if surrounded by extra text.
  A successfully-parsed verdict is authoritative and wins over ANY rate-limit
  heuristic (documented fix for a 2026-06-07 bug: `Test-RateLimited` ran over the
  *entire* combined output including repo docs the critic merely read, which
  described the earlier fix — false-triggering a 429 on a valid clean verdict).
  Rate-limit (exit 4) is reachable ONLY when parsing fails, using codex's real
  exit code.
- **Retry logic**: NONE inside `invoke-critic.ps1` itself — bounded retry lives
  in `conductor.ps1`'s worker↔critic loop (§2 step 3), not here. A single
  `invoke-critic.ps1` call either produces a verdict or signals rate-limited/unparseable.

---

## 6. Worker invocation (`invoke-worker.ps1`) — exact mechanics

- **Model ladder construction** (line 118-138), priority order:
  1. `-TouchesContractZone` → ladder = `[WorkerLadder[0]]` (single-element,
     comma-forced to avoid PS scalar-unwrap) = `[opus]` always, regardless of any
     declared model; WARN logged if a weaker model was declared.
  2. Else declared `-Model` found in `WorkerLadder` → sub-ladder from that
     index to the end (e.g. `sonnet` → `[sonnet, haiku]`; declared tier first,
     cheaper-only step-downs on rate-limit).
  3. Else declared `-Model` NOT recognized → WARN + full ladder (never crashes).
  4. Else (no declared model) → full ladder `[opus, sonnet, haiku]`.
- **Exact command per ladder step** (line 161-171):
  ```
  claude -p --model <model> --permission-mode acceptEdits --max-turns 100 `
      --verbose --output-format stream-json
  ```
  run via `Start-WatchedProcess` (from `watchdog.ps1`) with `-StdinText $prompt`,
  `-HeartbeatPath runtime/<id>/heartbeat`, `-StaleSeconds (15*60)`,
  `-TimeoutSeconds (20*60)`, `-ActivityPaths @(rtDir)`. `--output-format
  stream-json --verbose` is deliberate: it makes stdout continuous even during
  long silent reasoning, feeding the watchdog's process-driven liveness signal
  (see §1 watchdog.ps1 and the case-2 self-test that specifically guards this).
- **Prompt** (`Build-WorkerPrompt`, line 56-112): task id + full task-file body
  inlined, GOAL.md/INVARIANTS.md pointers, prior critic feedback block (if a
  retry round), explicit rules (touch ONLY `file_set`, never `forbidden_paths`,
  smallest change, `TOO_BIG`/`NEEDS_GUARD` stop conditions, do NOT `git commit`/
  `git add` except the one sanctioned `git add -N` for new-file diff visibility,
  do NOT run the gate, touch heartbeat at every significant step, emit specific
  output artifacts).
- **Rate-limit / timeout handling per ladder step** (line 173-190):
  `RateLimited=true` + `TouchesContractZone` → PAUSE (return `RATE_LIMITED`,
  break — never downgrade a contract-zone task). `RateLimited=true` +
  NOT contract-zone → log + `continue` to the next (cheaper) ladder entry.
  `TimedOut=true` → `TIMED_OUT`, break (no further ladder steps tried).
  Otherwise → `DONE`, break.
- **Watchdog interaction**: the watchdog is a generic subprocess-liveness harness
  (`watchdog.ps1`); `invoke-worker.ps1` is its only production caller. The
  worker's own model-driven heartbeat touches are ONE of three liveness signals
  (the others: stdout/stderr stream activity, and file-mtime activity under
  `runtime/<id>/`) — a model that goes silent mid-reasoning is NOT falsely killed
  as long as `--output-format stream-json` keeps stdout flowing.

---

## 7. Model routing — AS BUILT (the `s7-t1-conductor-model-tiering` change)

Source: `queue/done/s7-t1-conductor-model-tiering.md` (task spec) + the resulting
code in `_common.ps1`/`invoke-worker.ps1`/`conductor.ps1` (read live above — the
task's diff IS the current code, already merged).

**What changed and why** (task body, `s7-t1-conductor-model-tiering.md:26-34`):
before this task, EVERY worker spawn used the full `[opus, sonnet, haiku]` ladder
regardless of task complexity. The operator's *manual* (Agent-tool-driven)
workflow already tiered by complexity (haiku=trivial/mechanical,
sonnet=moderate, opus=complex/contract-adjacent); this task wires the SAME
tiering into the automated conductor so cheap/mechanical tasks don't burn an
Opus call by default.

**Mapping AS BUILT**:
1. Task frontmatter gets an optional `model: haiku|sonnet|opus` field
   (`_common.ps1:378` — `model = $null` default, StrictMode-safe when absent).
2. `invoke-worker.ps1` turns that declared tier into a **starting point of a
   sub-ladder**, not a hard pin: `model: sonnet` → ladder `[sonnet, haiku]`
   (rate-limit step-downs only ever go CHEAPER, never back up to opus).
   `model: haiku` → ladder `[haiku]` alone. No `model:` key → unchanged full
   ladder `[opus, sonnet, haiku]`.
3. **Contract-zone pin is untouched and wins unconditionally**: any task with
   `touches_contract_zone: true` is pinned to `WorkerLadder[0]` (opus) no matter
   what `model:` says; a mismatched declaration only produces a WARN log. On a
   429 a contract-zone task PAUSES rather than downgrading — this is the one
   piece of the ladder logic model-tiering was explicitly forbidden from
   changing (task spec "What NOT to change", line 74-79).
4. `conductor.ps1` is a pure pass-through: `-Model ([string]$task.model)` at the
   `invoke-worker.ps1` call site (cast so PowerShell `$null` becomes `''`).
5. `invoke-critic.ps1` was explicitly OUT OF SCOPE — the critic always runs
   GPT-5.5 high; there is no complexity-tiered critic (task spec line 33 and
   75: "critic tiering is mechanical and already correct; model already gpt-5.5").
6. Anti-drift is a THIRD, separate, fixed tier: always `claude -p --model
   sonnet` (`_common.ps1:71`, `AntiDriftModel`), unrelated to any task's declared
   `model:` — it judges program-intent drift across many tasks, not one diff.

Net: **three independent model choices** exist in the system — (a) per-task
worker tier (`model:` frontmatter, optional, sub-ladder + contract pin override),
(b) fixed critic tier (`gpt-5.5` / effort `high`, never varies), (c) fixed
anti-drift tier (`sonnet`, never varies). Nothing in the code computes a
complexity SCORE automatically — the operator/planner assigns `model:` when
authoring the task; the loop is purely mechanical about honoring it.

---

## 8. Escalation format (`escalate.ps1`) + delivery

Structure: see §3 "escalations/<id>.md" above. Every call site in `conductor.ps1`
supplies `Id / Reason / Type / TaskId / Title / What / Decision / OptionA /
OptionB / Cost / Evidence` (`Invoke-Escalation` wrapper, `conductor.ps1:128-135`).
`Move-Task` to `queue/escalated/` happens BEFORE the escalation write at every
call site that also needs to reroute the task (`conductor.ps1:443` comment: "Move
FIRST so the task is in escalated/ even if the artifact write throws") — a
partial-failure-safe ordering. Escalation-artifact write failures are caught and
logged as WARN, never allowed to crash the loop (every call site wraps
`Invoke-Escalation` in `try/catch`).

**Delivery** (`escalate.ps1:75-92`): if `AUTODEV_TELEGRAM_TOKEN` +
`AUTODEV_TELEGRAM_CHAT` env vars are both set, `Invoke-RestMethod POST
https://api.telegram.org/bot<token>/sendMessage` with a one-line summary
(`chat_id`, `text`); failure falls through to the outbox. Otherwise (or on
Telegram failure) appends a markdown checkbox line to `escalations/_outbox.md`
for a Claude-side relay or the operator to pick up manually. The real
`_outbox.md` shows this outbox becomes the operator's durable decision log —
each line is later hand-annotated with `RESOLVED <date>: <what the operator
chose and why>` prose, which is the actual audit trail of every human-in-the-loop
decision made across the S1 run.

---

## 9. Config / knobs (`Get-AutodevConfig`, `_common.ps1:41-92`)

| Knob | Default | Notes |
|---|---|---|
| `WorkerLadder` | `['opus','sonnet','haiku']` | contract-zone tasks pin to `[0]` only |
| `CriticModel` | `'gpt-5.5'` | must stay a non-Claude family (heterogeneity is load-bearing); comment documents `'gpt-5.3-codex-spark'` as the only sanctioned cheaper tier |
| `CriticEffort` | `'high'` | passed as `model_reasoning_effort` |
| `AntiDriftModel` | `'sonnet'` | Claude is fine here — judges intent drift, not its own diff |
| `WatchdogStaleMinutes` | 15 | no process activity → kill + respawn |
| `MaxAttempts` | 3 | circuit breaker; `>` this quarantines |
| `AntiDriftEveryCommits` | 5 | cadence for anti-drift + digest |
| `WorkerTimeoutMinutes` | 20 | hard cap per worker spawn |
| `WorkerMaxTurns` | 100 | passed as `--max-turns` to claude |
| `MaxSessionHours` | 8 | conductor wall-clock graceful exit |
| `RateLimitBackoffSeconds` | 600 | sleep after a 429 before re-claiming |
| `CriticRetryMax` | 1 | non-contract worker↔critic retries before escalating; per-task override via `max_rounds` frontmatter |
| `AllowedBranchPattern` | `'^autodev/'` | refuse to run/commit off this pattern; never `main` |
| `DirtyFenceIgnore` | `['.autodev/runtime/','.autodev/queue/','.autodev/escalations/','.autodev/conductor.log','.autodev/digest.md']` | loop scratch/operational paths ONLY — constitution files (`GOAL.md`/`INVARIANTS.md`/`GUARDS.md`) deliberately absent so a worker editing them is still caught |
| `ClaudeExe` | `'claude'` | resolved on PATH |
| `CodexExe` | `'codex'` | resolved on PATH |
| (CLI) `-SleepSeconds` | 30 | idle-poll interval when nothing claimable |
| (CLI) `-ReuseVerdict` | off | round-0-only clean-verdict reuse, gated on `diff_sha256` match |
| (CLI) `-SkipComposer` | off | fast structural dry-runs |
| (CLI) `-AssumeWorkerDone` | off | bootstrap/operator-as-worker mode |

Additional non-`Config` knobs: `AUTODEV_TELEGRAM_TOKEN` / `AUTODEV_TELEGRAM_CHAT`
env vars (escalation delivery), `gate.ps1 -ComposerSubcommand` (default `check`).

---

## 10. woodev-specific couplings to GENERALIZE

Every one of these must become per-project config in the TS core (project root /
`.env` / a harness config file), not a hardcoded assumption:

1. **Repo-root discovery is PHP/composer-specific.**
   `Get-AutodevRepoRoot` (`_common.ps1:27-39`) walks up looking for
   `composer.json` **AND** a `woodev/` directory. This literally cannot locate
   the root of a non-PHP, non-woodev project. → generalize to a configurable
   marker file/dir (e.g. `.git` + an explicit `--project-root` / config-file
   pointer), or a `.harness.json` marker the TS core writes on init.
2. **Test/build runner is hardcoded to `composer check`.**
   `Invoke-ComposerCheck` (`_common.ps1:523-530`) shells out to `composer
   <subcommand>` (default `check`), and this is the ONLY green/red signal the
   gate trusts pre-success_commands (`gate.ps1:193-200`) — it runs whole-tree
   unconditionally, even when the diff is scoped to a `file_set`. → generalize
   to a configurable "build/test command" per project (npm test, pytest, go
   test, etc.), separate from the already-generic `success_commands` per-task list.
3. **Guard test runner is hardcoded to PHPUnit.**
   `mutation-check.ps1:38-47` (`Invoke-GuardTest`) invokes `vendor\bin\phpunit.bat`
   / `vendor\bin\phpunit` directly with a single test-file arg. → generalize to
   a configurable test-runner command template (e.g. `{testRunner} {testFile}`)
   so JS (`vitest run <file>`), Python (`pytest <file>`), Go, etc. all fit the
   same guard-test contract.
4. **The anti-drift "phase intent" source is a hardcoded doc path + section headers.**
   `Config.Tracker = docs-internal\platform-v2-program-tracker.md`
   (`_common.ps1:59`); `Get-TrackerIntent` (`anti-drift.ps1:37-47`) regex-extracts
   specifically `## Next action` and `## Stage map` headings from that ONE file.
   → generalize to a configurable "intent source" path with configurable
   section-header patterns (or just "feed the whole file", simpler and more portable).
5. **Constitution paths are hardcoded to this repo's doc layout.**
   `INVARIANTS.md`'s `constitution.path_globs` (`INVARIANTS.md:137-148`) lists
   `PLANS.md`, `CLAUDE.md`, `AGENTS.md`,
   `docs-internal/platform-v2-program-tracker.md`,
   `docs-internal/platform-v2-execution-protocol.md`,
   `docs-internal/migration/*data-preservation*`, `**/*-policy.md` — this is
   blackboard DATA (already project-configurable in principle, since it lives in
   `.autodev/INVARIANTS.md` not code) but the harness's task-authoring
   conventions/examples should not assume this exact doc tree; ship an empty/
   generic template instead.
6. **Contract-zone examples are entirely WordPress/WooCommerce/PHP idioms.**
   `INVARIANTS.md`'s `contract_zones` grep_patterns hardcode `get_option\(`,
   `update_option\(`, `do_action\(`, `apply_filters\(`, `wp_schedule_event`,
   `register_rest_route\(`, `wp_ajax_`, `add_menu_page\(`, `wc_get_logger`,
   `update_post_meta\(`, `CREATE TABLE`, `dbDelta\(`, `$wpdb->prefix`. These are
   fine as a *worked example* for the woodev case but the TS core must ship this
   file as a per-project artifact the operator authors, not a built-in default —
   the concept (contract zones, guard-per-value, mutation-check) is portable;
   the patterns are not.
7. **The worker prompt hints at a PHP-specific tool.**
   `Build-WorkerPrompt` (`invoke-worker.ps1:75`): "Use Serena tools for PHP if
   they are available in your session; otherwise use Grep/Read." → generalize
   to a configurable "preferred code-nav tool" line, or drop the language
   qualifier entirely and let Serena's own project-detection handle it.
8. **Commit-type mapping is a fixed 2-way PHP/WP-project convention.**
   `conductor.ps1:429`: `$kind = task.type=='guard' ? 'test' : 'refactor'` for
   the Conventional Commits prefix. Reasonable default, but should be a
   configurable `{taskType: commitKind}` map so e.g. a `type: docs` task doesn't
   get committed as `refactor(autodev): ...`.
9. **State-directory naming (`'.autodev/'`) is this project's chosen name,
   hardcoded pervasively** (paths in `Get-AutodevConfig`, `DirtyFenceIgnore`
   prefixes, `AllowedBranchPattern` default `^autodev/`). Not wrong to keep as a
   DEFAULT, but every literal `.autodev/` string in the port should route through
   one config value so a project can rename it (e.g. `.harness/`) without a
   find-replace across the codebase.
10. **`docs-internal/` as the doc root for "internal, unpublished" material**
    (referenced by anti-drift's tracker path and constitution globs) is a
    woodev-framework convention, not a general one — the TS core should not
    assume any particular doc-tree naming.

---

## 11. Top code-vs-runbook divergences (design doc vs reality)

The runbook (`docs/reference/autodev-loop-runbook.md`, dated 2026-06-04, marked
"DESIGN (not yet implemented)") predates most of the real implementation. Code
wins on all of these:

1. **No per-task git worktrees — ever.** Runbook §4 pseudocode says
   `run_with_watchdog(claude -p ..., wt, ...)` implying a worktree `wt`, and its
   WORKER prompt (§2) says "Work in the **git worktree** you were started in" and
   "the change itself, **committed** to the worktree". Reality: there is no
   per-task worktree at all — all workers share ONE working tree, serialized
   purely by `file_set` disjointness (the scheduler IS the lock,
   `scheduler.ps1:5-15`; `invoke-worker.ps1:6-7` docstring is explicit: "no
   per-task git worktrees"). The worker is explicitly told NOT to `git commit`/
   `git add` (except the one sanctioned `git add -N`) — the conductor stages and
   commits `file_set` only, AFTER the gate (`invoke-worker.ps1:92-98`). This is
   the single biggest structural divergence and directly shapes the dirty-file
   fence (§3 below), which the runbook only sketches as a naive path-set diff.
2. **Guard coverage is per-VALUE, not per-zone.** Runbook §1's `GUARDS.md`
   example table has 5 columns and implies one guard blesses a whole zone.
   Reality (`gate.ps1:92-119, 226-307`): a guard's `recipe.canonical_value` must
   EXACTLY match a specific enumerated contract string; a sibling value in the
   same zone (e.g. a second option key) is NOT auto-covered — this was a real
   over-coverage bug fix, locked by `gate.ps1 -SelfTest` case 2 ("sibling-value
   uncovered (FIX)"). The real `GUARDS.md` table has 7 columns
   (`contract_id | contract_value | guard_test | recipe | mutation_verified |
   blessed_by | date`) vs the runbook's 5.
3. **The dirty-file fence is content-fingerprinted, not path-set-diffed.**
   Runbook §4: `worker_changed = git_status_changed_files() - pre_worker_baseline`
   (implies a simple path-set subtraction). Reality
   (`_common.ps1:270-334`): SHA256 content fingerprints of every raw changed
   path are snapshotted BEFORE the worker runs; a file is "touched" if its
   fingerprint is NEW or CHANGED, so a worker editing an ALREADY-dirty
   out-of-`file_set` file is still caught (a path-set diff would miss this,
   since the path was already "changed" pre-worker). Proven by `conductor.ps1
   -SelfTest` case 8.
4. **Gate `RETRY` routes to `pending/`, not `active/` — and this was itself a
   fixed bug, not a day-one design.** The runbook's pseudocode
   (`if not composer_check.green: retry(); continue`) doesn't specify where
   `retry()` sends the task. The real code has an extensive comment
   (`conductor.ps1:388-395`) documenting that an earlier version left RETRY
   tasks in `active/`, where the scheduler (which only claims from `pending/`)
   would never re-pick them — silently stranding composer-failing tasks
   forever (observed 2026-06-06 on 3 real tasks: rest-bootstrap, status-view,
   abstract-api). Fixed to `Move-Task → QueuePending`.
5. **Per-task worker `model:` tiering does not exist in the runbook at all.**
   Runbook §4's ladder is a flat `task.touches_contract_zone ? [opus] :
   [opus, sonnet, haiku-or-openrouter]` — no notion of a declared per-task tier.
   This entire mechanism (§7 above) was added later by the dedicated
   `s7-t1-conductor-model-tiering` task and is a genuine capability gap in the
   design doc, not just a rewording.
6. **Escalation `Type` enum is incomplete in the runbook.** Runbook §6 example
   lists only `needs-guard | disagreement | constitution | uncertain | poison`.
   Real `escalate.ps1:30-31` ValidateSet adds `blocked` and `dirty-file` and
   `drift` — all three are real, frequently-hit routes in `conductor.ps1`
   (TOO_BIG/BLOCKED-report → `blocked`; dirty-file fence → `dirty-file`;
   anti-drift DRIFT verdict → `drift`).
7. **Gate scoping to `file_set` (not whole working tree) was a bug fix, not
   original design.** Runbook §4's gate pseudocode grep-diffs "the diff"
   without specifying scope. Reality: `gate.ps1` defaults to whole-tree
   (`Get-GitChangedFiles`/`Get-GitDiffText`) but the PRODUCTION call from
   `conductor.ps1:378` always passes `-FileSet $task.file_set`, which restricts
   both zone-detection AND the diff text to just that task's files
   (`Get-GitFileSetChangedFiles`/`Get-GitFileSetDiffText`, `_common.ps1:491-507`).
   The gate docstring (`gate.ps1:176-182`) explains this was needed because a
   PARKED (uncommitted, escalated) task's stray files were leaking contract-zone
   false-positives into unrelated tasks' gate verdicts (two real 2026-06-06
   incidents: a warehouse `dbDelta` call leaking `db_schema` into
   `pickup-selection`'s verdict, and a `$this->id=` leaking `gateway_id` into
   `checkout-fields`).
8. **Rate-limit attempt-refund symmetry (worker AND critic) is undocumented in
   the runbook.** Runbook's fallback table (§4) says a 429 "return[s] task to
   pending with the attempt refunded" without distinguishing worker vs critic
   transports. Reality: this symmetry was itself a fixed bug
   (`conductor.ps1:74-83` docstring cites a real 2026-06-06 incident —
   `warehouse-store` was quarantined as poison after 3 back-to-back CODEX
   (critic) 429s even though the worker output was DONE and composer-green,
   because the critic path was MISSING the refund the worker path already had).
9. **`MaxSessionHours` wall-clock exit is entirely absent from the runbook.**
   Not mentioned anywhere in the design doc; real `conductor.ps1:600-605`
   gracefully stops the loop after 8h of wall-clock time, checked at the top of
   every outer-loop iteration (before spawning a worker, so it never kills
   mid-task).
10. **Commit-time branch re-check is a second, independent guard beyond the
    startup preflight.** Runbook §4 only shows the top-of-loop `preflight`.
    Reality (`conductor.ps1:412-428`) re-checks `git rev-parse HEAD`'s branch
    IMMEDIATELY BEFORE every commit, because a worker (or anything else) could
    move HEAD mid-run — the startup check alone is not sufficient over a
    long-running conductor session.

---

## Related

- `D:/Projects/autodev-harness/docs/reference/autodev-loop-runbook.md` — the
  design doc this spec supersedes for behavioral accuracy (kept for historical
  rationale/roles/economics — still valid on those points).
- `D:/Projects/woodev_framework/tools/autodev/*.ps1` — source of truth for all
  claims above.
- `D:/Projects/woodev_framework/.autodev/` — live blackboard; real task/verdict/
  escalation examples cited throughout.
