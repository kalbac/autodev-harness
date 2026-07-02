# SESSION LOG — Autodev Harness

> Newest entry on top. 10–20 lines per session.

---

## s12 — 2026-07-02 — `orchestrate` LIVE-PROVEN end-to-end on aurora (green COMMIT)

**Context:** s11 built the whole adr/003 layer; the ONE thing left was a live end-to-end proof of the
`orchestrate` path (the orchestrator's equivalent of the s09 P1 live proof). Read all anchors. Ran the
real thing on the disposable `aurora` sandbox (branch `autodev/s12-orch-proof` off `autodev/live-proof`;
`.autodev/` git-excluded; dependency-free gate `php -l …/LlmServiceFactory.php`; orchestrator role
defaults to `claude/opus`). Took **3 live runs** (the promt predicted decompose-prompt iteration).

**Run 1 — `supports()` intent → ESCALATE `dirty-file`.** opus decompose emitted a self-contradictory
spec: `forbidden_paths: ["…/Llm/*", "!…/LlmServiceFactory.php"]` — gitignore-style `!` negation the
harness glob matcher (`*`/`?`/`**` only) does NOT support. The `*` glob matched the very file `file_set`
required, so the dirty-file fence flagged the legit edit as forbidden → escalate before gate. `validateTaskSpec`
had ACCEPTED the impossible spec. **Enforcement worked; the decompose output was bad.**

**The fix (branch `autodev/s12-orch-liveproof`, commit `e7dbb46`):** sonnet subagent (TDD, no commit) →
my spec-check (parity vs fence's `forbiddenTouches`) → **codex GPT-5.5 gate: APPROVE, no findings**.
(1) `task-spec.ts` superRefine rejects any spec where a `forbidden_paths` glob matches a `file_set` entry,
reusing the fence's EXACT normalize-then-`globMatch` semantics (validator never diverges from enforcement);
(2) `decompose-prompt.ts` documents `forbidden_paths` semantics to the LLM (no `!`/gitignore, never overlap
`file_set`, leave empty for "touch only these files"). `normalizePath` moved to `util/glob.ts` (exported,
reused). +6 tests, typecheck clean, full suite 384 pass / 2 skip.

**Run 2 — `supports()` (rebuilt) → ESCALATE `uncertain`.** Clean pipeline this time (decompose→validate→
worker DONE→fence clean→gate), but the **codex critic correctly returned `uncertain` (0.86 conf)**: a new
public contract with no test, and aurora's dependency-free gate can't run phpunit to prove parity with
`make()`. The gate did its job — "never merge bullshit."

**Run 3 — class-docblock intent → GREEN COMMIT.** Self-evident, no new contract. Full live path:
opus decompose → clean spec → validate → enqueue → trigger → claude worker → gate `php -l` → **codex
critic `clean`** → **COMMIT `2c77106`** → merge to branch → worktree torn down. Task in `done/`, tree clean.
**R1 held**: orchestrator only authored the task file; all enforcement ran in the deterministic conductor.

**Operational gotcha:** background `orchestrate` runs get KILLED during the nested `claude` (opus) decompose
spawn in this Claude Code environment — **foreground runs succeed reliably**. Two gotchas filed.

---

## s11 — 2026-07-02 — R3 role registry SHIPPED (PR #21) + orchestrator design started

**Context:** First build session of the post-P1 architecture. Read all anchors (VISION, AGENTS, CURRENT-STATE,
GOTCHAS, adr/003, parity-spec §2/§5/§6/§7). Operator flagged that AGENTS.md was missing from the session-start
protocol → added it. Operator authorized **overnight autonomous mode** (subagent-driven + codex critic; merge
after codex-gate + green CI, pre-authorized).

**R3 — role registry + per-adapter config (adr/003 R3) — SHIPPED & MERGED (PR #21, `d07e72c`):**
- Two skeleton-adjacent forks surfaced to operator before coding: (Q1) where vendor knobs live → **role-shaped
  entries** (knobs inside each role, operator deferred to my judgment); (Q2) migration → **hard-cut to `roles:`**.
- sonnet-5 implementer (TDD, no commit) → my spec-check vs parity §7 → **codex GPT-5.5 gate**. Flat `worker:`/
  `critic:` → `roles: {orchestrator, worker, critic, planner}` + `policy.heterogeneity`. Worker keeps `ladder`
  (parity §7 intact). New `src/config/roles.ts` (adapter family/exe resolution, `assertKnownAdapters` fail-loud,
  heterogeneity policy). All 6 consumers migrated.
- **codex findings:** (1 High) legacy flat configs silently stripped → fixed with root `.strict()` (fail loud) +
  regression test; (2 Med) empty `ladder` passes schema then throws at runtime → fixed with `.min(1)` (NOT min(2):
  single-element ladder is valid per §7); (3 Med) heterogeneity-warn unreachable → **declined** (assert-before-warn
  is intentional; warning is forward-looking). **Re-critic clean.** typecheck clean, 287 tests, CI green 4/4.
- aurora `.autodev/config.yaml` migrated to `roles:` (else `.strict()` would reject it).

**R1/R2 orchestrator layer — FULLY BUILT (overnight, subagent-driven + codex critic):** operator authorized
overnight autonomy + pre-authorized merges (gate+green-CI). Plan subagent produced the design spec
(`docs/superpowers/specs/2026-07-02-orchestrator-layer-design.md`), 5 skeleton-shaping forks surfaced 🔴, operator
approved "да по всем" (A1 staged pipeline · B1 CLI verb · C1 decompose-only claude/opus adapter · D digest+stdout
report · E strict validateTaskSpec).
- **Substrate (PR #22):** `TaskSpec`/`validateTaskSpec` (sole trust boundary for LLM-authored tasks), `serializeTask`
  (proven inverse of `parseTask`), standalone `writeTaskToPending` (frozen-seam-safe), read/report caps, and a
  mechanical R1 import trip-wire. codex: 6 findings fixed + re-critic clean.
- **Logic (wave 1):** decompose-only `ClaudeOrchestratorAdapter` (one-shot `claude -p`, `cwd:repoRoot`, tolerant
  balanced-bracket JSON parse) + staged `createOrchestrator().handleIntent` (snapshot→decompose→validate-all-or-
  nothing→transactional-enqueue-with-rollback→bounded-trigger(skip-on-empty)→report). codex: 4 findings + a
  re-critic consistency fix (empty array = valid no-op).
- **Wiring (wave 2):** `index.ts` composition root builds exactly the 4 caps; `trigger` = bounded `conductor.run`
  closure (no gate/worker/commit handle reaches the orchestrator — R1 mechanically held). New `orchestrate
  "<intent>"` CLI verb. codex: 1 finding (argless trigger unbounded) fixed. Build + CLI smoke-tested.
- Result: `node dist/index.js orchestrate "<intent>"` decomposes intent → task files → triggers the un-bypassable
  gate. 378 tests, typecheck clean. **NOT yet live-proven end-to-end on a real repo** (s12).

---

## s10 — 2026-07-02 — `adr/003` design gate → **accepted** (role matrix + LLM orchestrator)

**Context:** Continued from s09 (P1 DONE, 272 tests, all merged, no tail). s10 was a **design gate, not a
build sprint** — the next-session prompt forbade starting orchestrator code until `adr/003`'s open questions
were resolved with the operator. Read the anchors + `adr/003` fully, then ran the design conversation.

**Resolved all 4 open questions with the operator (all recommended options chosen):**
- **R1 boundary — orchestrator STRICTLY ABOVE the pure-code conductor.** The LLM gets exactly 4 capabilities:
  enqueue a `queue/pending/*.md` task file, trigger the loop, read blackboard state, report + drive kanban.
  Every enforcement step (`claim→worktree→worker→harvest→fence→critic→gate→commit`) stays in the deterministic
  conductor; **no** `run_worker`/`run_critic`/`run_gate`/`commit` tool. The LLM's only enforcement-path write is
  a task file the scheduler independently validates → preserves the PS-oracle "can't talk past the gate" 1:1.
- **R2 planner — folded into the orchestrator for MVP**, reserved as a registry role id; output = `queue/pending/*.md`.
- **R3 config — unified `roles:` registry** (`{adapter,model,effort?,exe?}` per role) + global defaults + sparse
  per-project override + `policy.heterogeneity: warn`. Flat `worker`/`critic` blocks migrate in — the axis-2/6
  generalization the frozen skeleton anticipated, not a break.
- **R4 orchestrator window/session model — deferred to P2** (window-shaped, over the read-only `api` seam).

**Deliverable:** `adr/003` proposed → **accepted** (Resolution R1–R4 + rewritten Consequences); `VISION.md` banner
+ `CURRENT-STATE.md` (open question resolved, NEXT ACTIONS re-pointed to s11) updated. **No source changed** — by
design. Docs-only → **PR #18 merged to `main` (`6b7ab2b`)** (operator-approved the gated squash-merge; the
self-approval classifier correctly blocked the agent's own auto-merge). No codex gate (pure docs, per restraint rule).

**Next (s11), now buildable:** (1) role registry + per-adapter config (R3, config/adapter change, full discipline
+ codex gate), then (2) the additive orchestrator layer (R1/R2) on the existing scheduler + run entrypoint + `api` seam.

## s09 — 2026-07-02 — live build-step-9 on a real repo → **P1 real-world DoD reached** (green COMMIT)

**Context:** Continued from s08 (265 tests, PR #13 merged). Step 0 tails: wrote the `[node/stdin-epipe]`
gotcha (count 11→12), saved 2 cross-project TS/Node learnings to Supermemory — docs branch → **PR #15 merged**.

**Build-step-9 — the last P1 gate — done.** Ran the harness end-to-end on a REAL woodev-class repo with a
live `claude` worker + live `codex` critic and reached a **green COMMIT** matching the PS oracle.
- **Target:** operator dropped `open-warehouse` (dirty tree) → picked `aurora` (disposable Laravel sandbox
  in `d:/projects/`). Dependency-free gate `php -l server/app/Services/Llm/LlmServiceFactory.php`; task `live01`
  (name supported providers in the unsupported-provider error). Runs on `autodev/live-proof`, `.autodev/` git-excluded.
- **First run → ESCALATE (dirty-file):** the worker wrote `worker-report.md` into the worktree root → fence
  flagged it stray → no task can COMMIT. **Finding #4 (blocking).**
- **Fix #4 (`ded192e`)** — `src/worker/report.ts` `harvestWorkerReport` relocates the report worktree→runtimeDir
  before status-read+fence (parity §6). codex gate returned **broken** (stale carry-over on retry/re-claim;
  non-atomic EXDEV; test covered only the status-read half) → fixed → **re-critic clean**.
- **Second run → `spawn codex ENOENT`:** fence PASSED (fix #4 proven live), reached the critic; node can't
  spawn the Windows `codex.cmd` shim. **Finding #5.** **Fix #5 (`76e0ab3`)** — `runNative` via `cross-spawn`;
  win32-gated regression test; codex-gated (only flagged risk = the added dep, satisfied).
- **Third run → GREEN COMMIT:** CLAIM → worktree → claude(sonnet) → harvest → fence(pass) → **codex `clean`
  (conf 0.76)** → gate `php -l` green → **COMMIT `3ffe028`** → task `done` + digest line. Oracle-equivalent.

**Merged:** both fixes → **PR #16 merged to `main` (`d137f2b`)**, all 4 CI cells green. 272 tests + 2 skipped.
**Findings captured:** #4/#5 (fixed) + 3 operational (worktree lacks deps; dirty tree breaks merge; `.autodev/`
must be git-excluded) → gotchas (count 12→15). **Discipline:** 3 codex gates + 2 re-critics (both caught
incomplete fixes) — never self-certified.

## s08 — 2026-07-01 — thin api + parity harness + cross-platform CI (P1 DoD, fixture side; steps 8–9 done)

**Context:** Continued from s07 (233 tests). s07 PR `feat/conductor-p1` already merged to `main` (#12) —
step 0 was a no-op. Branched `feat/p1-dod-api-parity-ci` off `main`. Same discipline: sonnet-5 implementers
(TDD, no commit) → controller spec-check vs the PS oracle/parity spec → whole-module codex GPT-5.5 gate →
adjudicate → fix + regression test → **re-critic every fix**.

**Built (sequential, one commit per task):**
- **Task 27 `src/api/server.ts`** (`77c3b36`) — thin `http`+`ws` over `BlackboardRepository` (P2 seam,
  read-only+reply-only). `GET /state` (5 queues + bounded digest tail), WS change-stream (injectable chokidar),
  `POST /escalations/:id/reply` = STRUCTURED A/B only (`note` free text is context, never a worker instruction —
  §8 injection surface). Frozen repo seam untouched; clean http+ws+watcher teardown. +13 tests.
- **Task 28 `test/parity/parity.test.ts`** (`3b17512`) — the **P1 DoD parity harness**: drives the REAL
  conductor + real FileBlackboardRepository + real scheduler + real escalate over a temp `.autodev` tree, fake
  worker/critic/worktree/git + scripted gate, asserting the same COMMIT/ESCALATE/RETRY + queue/escalation
  end-state as the PS oracle (§2). 18 scenarios: 5 core + divergences #1/#4/#8/#9/#10 + dirty-fence (stray +
  forbidden, each arm isolated) + critic-retry + NEEDS_GUARD/BLOCKED + merge-conflict + run() backoff.
- **Task 29 CI + schema fix** (`38adf44`) — GH Actions matrix win+linux × node 20/22 (`npm ci`→typecheck→test
  →build→assert schema in dist). Fixed deferred `[critic/codex]`: `scripts/copy-assets.mjs` (`postbuild`,
  cross-platform) copies `critic-verdict.schema.json` into `dist/critic/`. Also added `tsconfig.typecheck.json`
  (the parity harness surfaced that `tsconfig.json`'s `include:["src/**"]` made `npm run typecheck` vacuously
  green for `test/**`). **264 tests / 2 skipped, typecheck (src+test) clean.**

**Codex gates (3 module passes + 2 re-critics):**
- *api (Task 27):* 3 findings, all accepted (unbounded body → 1MB cap + 413 + socket teardown on finish; id
  guard → positive allowlist `^[A-Za-z0-9_-]+$`; `/state` → bounded 64KB positioned digest tail). **Re-critic**
  caught an incomplete digest-tail fix (over-broad partial-line drop on an exact-boundary window) → over-read
  one byte + boundary regression test. My own first 413 fix was buggy (destroyed the socket before flushing →
  client reset) — fixed to teardown on response `finish`.
- *parity (Task 28):* 8 findings, all accepted — incl. one **"passes for the wrong reason"** (scenario 2 set
  BOTH contractRisk OR-arms). Hardened: split 2a/2b, gate/sleep call recorders, dirty-fence coverage,
  critic-retry, backoff, NEEDS_GUARD/BLOCKED, merge-conflict. **Re-critic** caught 2 vacuous assertions (the
  dirty-fence `stray:`/`forbidden:` labels are ALWAYS emitted → asserting the label passes regardless of
  content; forbidden test didn't isolate the forbidden arm) → assert actual paths + isolate the arm.

**Gotchas found:** `[ts/typecheck-scope]` (emit-scoped `tsconfig` `include:["src/**"]` silently skips `test/**`
in `tsc` → typecheck vacuously green there; separate `noEmit` typecheck config). `[api/413-teardown]`
(destroying an HTTP socket on oversized body before flushing the response = client reset, not 413; teardown on
response `finish`). `[test/vacuous-assert]` (parity-harness lesson: assert the value, not an always-present
label; isolate one OR-arm per test).

**CI flake found+fixed on the PR (`790ffc9`):** the first cross-platform run went red on ONE cell
(ubuntu/node20) — a real EPIPE race in `src/util/native.ts`: writing `child.stdin` with no `'error'`
listener, so a git child that closes its read end fast made `stdin.end()` throw an UNHANDLED EPIPE and crash
the run (the other 3 cells passed on timing). Fixed at the root (swallow the benign stdin write error;
stdout/stderr/exit are captured separately) + a deterministic regression test (exit-before-reading-1MB-stdin).
NOT "re-run until green" — that would hide the bug. Re-run → **all 4 cells green** (ubuntu+windows × node
20/22): the Windows lock is provably gone.

**Merged:** PR **#13** → `main` (`cde17a2`, merge commit, 5 commits incl. the EPIPE fix). Branch deleted, `main`
synced. **P1 fixture-side DoD = done.**

**Deferred tails (→ s09):** write the `[node/stdin-epipe]` gotcha file; save 1–2 cross-project TS/Node learnings
(`[ts/typecheck-scope]`, EPIPE) to Supermemory.

**Next:** build step 9's live woodev workload (operator picks target) = the P1 real-world DoD.

---

## s07 — 2026-07-01 — Conductor loop + scheduler + composition root (step 7 done; loop runs end-to-end)

**Context:** Continued from s06 (193 tests). Same discipline: sonnet-5 implementers (TDD, no commit) →
controller spec-check vs the PS oracle → whole-module codex GPT-5.5 gate → adjudicate → fix + regression
test → **re-critic the fixes**. Branch `feat/conductor-p1`.

**Built (SEQUENTIAL — the conductor is one tightly-coupled module):**
- **Task 23.5 `scheduler/scheduler.ts`** (plan-gap; the numbered tasks skipped it) — port of `scheduler.ps1`:
  deps-first then file_set disjointness vs active∪escalated locks, atomic claim with lost-race skip,
  `listClaimable` report; pure over `BlackboardRepository` (fake-repo testable). 9→10 tests.
- **Tasks 24–26 `conductor/conductor.ts`** — the whole parity §2 spine + outer loop, pure wiring/zero-LLM,
  full DI so all 8 self-tests run on fakes with zero subprocesses. Honors divergences #1 (worktree
  adaptation), #4 (RETRY→pending, not refunded), #8 (symmetric worker+critic 429 refund), #9
  (MaxSessionHours at top), #10 (commit-time branch re-check). 26→28 tests.
- **Step-7 close-out (parallel subagents):** `src/index.ts` production composition root (thin entry: flags →
  construct every real dep → `conductor.run`) + `src/util/log.ts`; and worktree `create()` made
  **re-queue-safe** (prune + remove --force + rm stale dir + branch -D before add) + taskId traversal guard.
  **233 tests / 2 skipped, typecheck clean** (was 193).

**Codex gates (two whole-module passes + two re-critics):**
- *Conductor+scheduler diff:* 5 findings → **2 rejected as faithful to the PS oracle** (activeSets computed
  once before the scan; `TrimStart('./')` is a char-set trim that strips `../` identically), **3 accepted**:
  scheduler imposes its own id order (don't rely on repo ordering), commit-time re-check must also require
  `cur === loopBranch`, teardown-in-finally must not reject a decided iteration. **Re-critic** refuted the
  teardown fix as incomplete (catch-block `log()` had no never-throws contract) → `safeLog` + throwing-logger
  test (the `[ts/fail-closed]` gotcha again).
- *Integration diff:* 6 findings → **2 deferred with docs** (`zonesTouchedInDiff` main-root invariants;
  `splitCommand` not quote-aware), **4 fixed**: guard-recipe matched by full row identity (per-value #2),
  `--max-iterations` validated as a positive int, taskId path-traversal guard, orphaned-dir rm. **Re-critic**
  caught the `--max-iterations` fix missing the no-value case → closed.

**Gotchas found:** `[ts/test-hang]` (an unterminated `run()` loop with no-op async deps starves vitest's
macrotask timer → uncatchable hang, process-killed at 5 min — two conductor *tests* were wrong, the code was
right; also: a new foreground shell command kills the running background one — killed my own test runs +
orphaned 186 node procs → OOM). `[conductor/wiring]` (the two deferred integration limitations + index.ts is
untested glue by design).

**Next:** thin `api` (Task 27) → parity harness + cross-platform CI (28–29) → P1 DoD. PR `feat/conductor-p1`
awaiting operator-approved merge (Claude-Code classifier blocks self-authored `gh pr merge`).

---

## s06 — 2026-07-01 — Watchdog + escalate + anti-drift + fingerprint (Tasks 20–23, step 6 done)

**Context:** Continued from s05 (155 tests). Same discipline: sonnet-5 implementers (TDD, no commit) →
controller spec-check vs the PS oracle → whole-module codex GPT-5.5 gate over the combined diff →
adjudicate → fix + regression test → **re-critic the fixes**.

**Built (4 disjoint modules, dispatched in PARALLEL):** Task 20 `watchdog/watchdog.ts` — makes the
`runner.ts` seam real: `runWatched` liveness = newest of (stdout/stderr stream activity, heartbeat mtime,
newest mtime under `activityPaths`), kill whole process tree on stale/hard-timeout; cross-platform tree-kill
(Win `taskkill /T /F`; POSIX detached process-group SIGKILL) + `isRateLimited` (Test-RateLimited parity);
added optional `pollMs` to the seam (backward-compatible). Task 21 `escalate/escalate.ts` — artifact
(verbatim template) + best-effort Telegram/outbox delivery, injected fs/http/env, never-throws, no task-move.
Task 22 `anti-drift/anti-drift.ts` — configurable intent source (whole-file or header-extracted, coupling #4)
+ injected model runner → one digest line; unparseable/failed → UNCERTAIN. Task 23 `util/fingerprint.ts` —
content-keyed SHA256 fence (divergence #3): `snapshot`/`workerTouched`/`strayChanged`/`forbiddenTouches`.
**193 tests / 2 skipped, typecheck clean** (was 155).

**Codex gate (4 findings): 3 accepted, 1 rejected as anti-parity.** ACCEPTED — (F1) anti-drift didn't wrap
the model call → a thrown `runModel` was fail-hard; PS `anti-drift.ps1:82-88` catches → wrapped to UNCERTAIN
+ still writes digest. (F3) `forbiddenTouches` matched the raw path; PS `Test-GlobMatch` normalizes BOTH
sides → a `./`-prefixed forbidden touch was fail-open → normalize before match. (F4) `escalate` env/log reads
were unguarded vs the documented never-throws → `safeLog` + guarded env. REJECTED — (F2) "multiline `/im`
verdict match accepts a later line" is **verbatim `anti-drift.ps1:91` `(?im)^\s*(...)`** — matching the
oracle IS the contract; UNCERTAIN fallback is only for NO-prefix output.

**Re-critic** refuted the F1 fix as incomplete (catch-block logs still unguarded → a throwing logger re-throws
the fail-closed path) → routed all `runAntiDrift` logs through `safeLog` too; confirmed F3/F4 and the F2
rejection. Each fix gated by a regression test.

**Merged:** PR (step 6 batch) → `main`. Codex Windows-sandbox couldn't spawn pwsh/serena
(`CreateProcessAsUserW failed: 5`) but reviewed fine from the inline diff (known gotcha).

**Next:** step 7 — `conductor` wiring (Tasks 24–26), then thin `api` (27), parity harness + CI (28–29).

---

## s05 — 2026-07-01 — Gate group (Tasks 15–19): the correctness core (step 5 done)

**Context:** Continued from s04 (101 tests). Same discipline: sonnet-5 implementers (TDD) →
controller spec-check vs the PS oracle → **whole-module codex GPT-5.5 gate** → adjudicate findings.

**🔴 Resolved before Task 16 (guards/recipe design):** read real `.autodev/GUARDS.md` + recipe files.
Confirmed the table's `contract_value` cell is human-facing (can list `+`-joined siblings) while the
machine per-value key is the recipe's `canonical_value`, and `zone_id` lives ONLY in the recipe. Chose
**(b)**: `guards.ts` is a pure fs-free table parser + selectors over enriched `GuardRecipePair[]`; recipe
loading (fs) is the gate's job. This mirrors the PS split (`Get-AutodevGuards` + `Get-AutodevGuardRecipePairs`
+ pure `Select-*`) exactly — decided from real data, no operator escalation needed (files confirmed the spec).

**Built (all in `src/gate/`):** Task 15 `invariants.ts` (MACHINE-INVARIANTS zod parse, types derived from
schema; `zoneTouched`/`zoneTouchedStrings`/`diffAddedRemovedLines`), Task 16 `guards.ts` (table parser +
per-VALUE `selectGuardForValue` / zone-fallback `selectGuardForZone`), Task 17 `mutation-check.ts`
(GREEN→RED→GREEN, `replaceAll`, byte-exact restore in `finally`, injected runner), Task 18 `gate.ts`
(decision core, exact §4 order, all I/O via `GateDeps`), Task 19 `self-test.test.ts` (5 `gate.ps1 -SelfTest`
cases). Three leaf modules dispatched in PARALLEL (disjoint files). **155 tests / 2 skipped, typecheck clean.**

**Pinned subtle parity from the PS source:** case-sensitivity asymmetry (`zoneTouched` case-INsensitive via
`-match`/`-like`; `zoneTouchedStrings` case-SENSITIVE via `.Contains`); `String.Replace`→`.replaceAll`
(JS `.replace` = first-only, a real bug); empty-file_set fast-path (incl. `!range` guard) BEFORE loaders.

**Codex gate:** correctness core (per-value-no-fallback, case-asymmetry, replaceAll/byte-restore, table
indexing) **confirmed clean**. 3 findings on gate-dependency-failure resilience — **all rejected as
anti-parity**: PS loads invariants/guards before the check too (`gate.ps1:168-170`<`:194`); the `!range`
guard is verbatim `gate.ps1:149`; a broken constitution file isn't worker-fixable (→ conductor fail-closes
to ESCALATE, §2 step 7, not RETRY). Documented the throw/fail-closed contract in `runGate`'s JSDoc.

**Merged (self-merge, operator-confirmed):** PR #10 (gate group) + PR #9 (batch-rule) → `main`. 6 granular
commits. Codex Windows-sandbox couldn't read skill files (`CreateProcessAsUserW failed: 5`) but reviewed
fine from the inline diff (per the known gotcha).

**Next:** step 6 — `watchdog` + `escalate` + `anti-drift` (Tasks 20–23).

---

## s04 — 2026-07-01 — Worker claude-adapter + full critic module (step 3 done, step 4 done)

**Context:** Continued from s03 (PR #1 merged). Same discipline: sonnet-5 implementer (TDD) →
controller spec-check vs parity spec → **codex GPT-5.5 gate per module** → fix subagent + re-critic.
Operator set two durable rules mid-session (→ `AGENTS.md`, memory): **Russian to the operator /
English for all artifacts**, and **the agent always does merges/commits/PRs itself** (operator only
approves a classifier-gated merge). Adopted **per-module PRs** for the rest of P1.

**Built:**
- **Task 11 `worker/claude-adapter`** (PR #3): first live `claude -p` adapter driving the model ladder
  through an injected `WatchedProcessRunner` seam (`src/watchdog/runner.ts`; real watchdog = Task 20).
  Parity §6 exact: contract-zone+429 PAUSE (no downgrade), non-contract+429 step-down, timeout→TIMED_OUT,
  ladder-exhausted→RATE_LIMITED. Transport status only; live path behind `ADH_LIVE=1`.
- **Tasks 12–14 `critic` module** (PR #5): `verdict.ts` (tolerant first-`{`-to-last-`}` parse, strict zod,
  `attachDiffSha256`), `fencing.ts` (physically moves `worker-report.md` out for the codex call,
  non-masking restore), `prompt.ts` (adversarial framing + 4-item checklist + inline diff), `codex-adapter.ts`
  (empty-diff→synthetic clean no-spawn; one fenced `codex exec`; verdict resolution outfile→stdout→exit-code,
  parsed-wins-over-429), `critic-verdict.schema.json`. Two implementer dispatches (12–13 pure, then 14).

**Codex gate earned its keep again:** on the critic module the whole-module gate caught a **High** bug the
subagent's own narrower codex pass missed — a **stale `-o` outfile** readable as this run's verdict across
retry rounds (fixed: `rm` before spawn). Plus `z.number().int()` line parity, non-masking fence restore,
schema-path export guard. All fixed in one pass → **re-critic on the fix diff came back clean**. Weak parts
of findings rejected with reasoning (copy+unlink atomicity redesign; brittle restore-failure test).

**Gotcha logged:** `critic-verdict.schema.json` is not copied to `dist/` by `tsc` — deferred to Task 29.

**Merged (self-merge, operator-authorized):** PR #3, PR #4 (AGENTS.md), PR #5 → `main`. **101 tests passed /
2 skipped, typecheck clean** on `main`.

**Stopped at a clean module boundary (not out of context):** the **gate group (Tasks 15–19)** is the
correctness core and Task 16 `guards` has a genuine design decision to settle first — see CURRENT-STATE
"Open questions". Deliberately deferred to a fresh session rather than improvised.

---

## s03 — 2026-07-01 — P1 foundation built (subagent-driven + codex gate)

**Context:** Fresh session per the s02 handoff. Operator wired the remote
(`github.com/kalbac/autodev-harness`) and set the coding workflow: **subagent-driven,
worker = sonnet-5, mandatory codex GPT-5.5 critic per module**. Ran mostly autonomously
(operator asleep).

**Setup:**
- Wired `origin`, pushed `main`. **Push to `main` is gated by the safety classifier** → adopted
  PR-flow: all work on `feat/p1-core-loop`, growing **PR #1**. (Correct for our own discipline.)
- Repo hygiene: gitignored `next-session-promt.md` + whole `references/`; untracked
  `references/MANIFEST.md`, preserved its pinned-SHA recipe as tracked `donor-extraction/DONOR-SOURCES.md`.
- Ran `writing-plans` → `docs/superpowers/plans/2026-07-01-harness-p1-core-loop.md` (TDD, grounded
  in the parity spec, spec-coverage table).

**Built (build-order steps 1–2 + start of step 3; each = sonnet-5 implementer → I spec-check → codex GPT-5.5 gate → fix subagent):**
- Steps 1–2: Task 0 scaffold (ESM/TS/vitest/zod/yaml), Tasks 1–2 `util/native`+`util/glob`, Task 3 `config`,
  Tasks 4–5 `blackboard` (task parser + file repo = state seam), Tasks 6–7 `util/git`+`worktree`.
- Step 3 (partial): Task 8 `router` (model-ladder resolution); Tasks 9–10 `worker/prompt` + `WorkerAdapter`
  interface + fake adapter. **Task 11 (live `claude` spawn) NOT started** — needs the watchdog seam + live validation.
- **60 tests green, typecheck clean** (independently re-verified in the main context, not just trusted).

**Codex gate earned its keep — real defects caught pre-merge:** stdin-hang + multibyte-UTF-8
corruption (native); non-object-YAML-root + keyless error (config); **exploitable path-traversal via
task id** + frontmatter delimiter anchor + TOCTOU (blackboard); dirty-tree merge + string-based
conflict false-positive + missing `--` arg terminators (git/worktree); `router` was **clean**; verbatim-body
+ fenced prompt regions (worker). Every finding → fix subagent + regression test (weak findings rejected with reasoning, e.g. the worker `.trim()` and JSON-escape suggestions).

**Decisions (minor/reversible, per handoff rule):** license Apache-2.0; config file `.autodev/config.yaml`;
branch renamed `master`→`main`; worktrees via AO pattern (deliberate divergence #1 from PS shared-tree);
`WorkerAdapter` returns TRANSPORT status only (DONE/RATE_LIMITED/TIMED_OUT) — report statuses parsed by the
conductor (parity §6), correcting the plan's mixed `WorkerStatus` sketch.

**Merged:** operator authorized self-merge → **PR #1 merged to `main`** (merge-commit `3c4a7ad`, preserving the
granular feat+codex-fix history as a dogfooding audit trail); branch deleted; 60 tests green on `main`.

**Not done / next:** finish step 3 (`worker` Task 11 claude-adapter via injected watchdog runner) → steps 4–9
(`critic`→`gate`→`watchdog/escalate/anti-drift`→`conductor`→`api`→parity harness+CI). Operator to pick the live
woodev parity target. See `CURRENT-STATE.md` → NEXT ACTIONS. New gotcha: codex-exec Windows sandbox.

---

## s02 — 2026-07-01 — Pivot, donor extraction, P1 spec

**Context:** New session opened on the day-zero scaffold. Operator corrected direction
before any clone: **stop treating AO as the fork base** — build our *own* harness from the
best of the donor candidates + our proven autodev-loop, in a new repo
`github.com/kalbac/autodev-harness`.

**Method (dogfooding our own discipline):**
- Ran `superpowers:brainstorming`. Locked ambition = **MVP "Loop + UI", architected toward
  product**; stack = **Node LTS + TypeScript** core (headless daemon) + local web UI;
  **file-blackboard = single source of truth**; worker `claude -p` / critic `codex exec`.
- **Donor extraction:** cloned 4 donors into `references/` (git-ignored, pinned SHAs) +
  discovered OpenHands' real code lives in `software-agent-sdk`. Dispatched **5 Sonnet-5
  agents** (4 donors + a parity-spec of our own PS loop) → detailed briefs. Synthesized
  `decision-matrix.md` (🔴 architecture-shaping / 🟡 graftable / ⚪ reject).
- **Proportional codex GPT-5.5 verification** of the 🔴 claims + parity-spec against real
  code: **17/18 CONFIRMED, 1 PARTIAL (AO A3), none refuted.** Matrix → VERIFIED.

**Decisions:**
- `adr/002` — build own harness; AO demoted to one donor. **6 skeleton axes frozen** (state
  blackboard-only + seam / pluggable worker adapter / commit-after-gate / per-worktree /
  independent critic + reject self-critique / declarative model routing).
- Key findings: no donor does complexity routing (ours is best-in-class); AO "chat-scroll
  bug" is a phantom; self-critique (OpenHands in-loop, Open Design Critique Theater) is our
  exact anti-pattern.

**Done:** wrote `docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` (P1 core
loop). Updated VISION banner, `adr/002`, CURRENT-STATE, 2 gotchas.

**Not done / next:** `writing-plans` + P1 implementation **deliberately deferred to a fresh
session** (this one's context was full). Create the remote repo first. PS loop continues as
the parity oracle. See `CURRENT-STATE.md` → NEXT ACTIONS.

---

## s01 — 2026-07-01 — Bootstrap & charter

**Context:** Spun out of a woodev-framework orchestrator session. Operator was
evaluating AO (Agent Orchestrator) as a replacement/complement for our
project-bound `autodev-loop` and hit its limits: no per-task model routing, no
critic-reviewer setting, and a chat-scroll bug in the desktop UI.

**Decisions:**
- **Fork AO** rather than wait for upstream to grow our features (`adr/001`).
- Project name **Autodev Harness**; slogan *"Let agents code, but never let them
  merge bullshit."*
- **Single source of truth = AO's session/PR model.** Port autodev-loop's
  *policies* (critic gate, contract-zone guards, model routing, anti-drift), drop
  its *plumbing* (PowerShell conductor, file-queue blackboard).
- Build in three ROI-ordered tiers (Tier-0 orchestrator-driven → Tier-1 small fork
  changes → Tier-2 deep native). Tier-1 = `--model` per-task, scroll-bug fix,
  critic kanban column.

**Done:**
- Scaffolded `docs/` with the proven woodev-framework structure.
- Wrote `VISION.md`, `CLAUDE.md`, `CURRENT-STATE.md`, `AGENT-RULES.md`,
  `DOCS-INDEX.md`, `DOCS-SCHEMA.md`, `GOTCHAS.md`, `FUTURE-BACKLOG.md`, `adr/001`.
- Ported crown reference docs: `reference/autodev-loop-runbook.md`,
  `reference/ao-codex-critic-protocol.md`.
- `git init` + initial commit.

**Not done / next:** AO source not cloned yet. Next session: clone AO, set up
fork hygiene (upstream remote), scope Tier-1 with real effort numbers. See
`CURRENT-STATE.md` → NEXT ACTIONS.
