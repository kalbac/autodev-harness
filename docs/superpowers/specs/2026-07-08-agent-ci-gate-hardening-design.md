# Optional agent-ci gate hardening — an extra, never-mandatory machine-gate check

> Design spec. Authored 2026-07-08 (s33). Follow-up to `wiki/agent-ci-analysis.md`'s
> 5-way verdict on `github.com/redwoodjs/agent-ci` (FSL-1.1-MIT) — the recon concluded
> "not a must-have, not redundant" for the core architecture, but surfaced one genuine
> footnote worth building: this spec is that footnote, done properly per the operator's
> correction ("not replacing anything — strengthening the loop, optional, never
> mandatory"). Discipline: touches `gate.ts` (the project's most sensitive module) →
> TDD + typecheck + `npm test` + **mandatory codex GPT-5.5 critic gate**, no exceptions.

## 1. Problem

Today's machine gate (`src/gate/gate.ts`) proves a task's diff two ways before commit:
a whole-tree `checkCommand` (e.g. `composer check`) and each task's own
`success_commands`, both run directly in the task's isolated git worktree. Both are
**local, dependency-light checks** — by design (see gotcha `[conductor/real-repo-run]`:
a fresh worktree has no gitignored deps, so the gate deliberately avoids anything that
needs a fully-provisioned environment).

For a project that ALSO ships its own real `.github/workflows/*.yml` CI (matrix builds,
services, a clean-container-only step, integration tests our lightweight checks don't
run), that real CI executes entirely **after** merge, on GitHub's infrastructure, with
zero visibility from the harness. Our gate can bless and commit a change that the
project's own real CI would then reject — a genuine gap in "never merge bullshit," not
a hypothetical one: the harness's pre-merge story and the project's actual CI story are
two disconnected systems today.

`redwoodjs/agent-ci` replays the **unmodified, official** GitHub Actions runner locally,
against a worktree's current file state (no commit required) — a close operational match
for our per-task worktree model. This spec adds it as an **optional, project-config-gated,
additional** step inside the existing machine gate — never replacing the independent
critic, never mandatory, off by default.

## 2. Goals / Non-goals

**Goals**
- Let a project opt in (`gate.agentCi.enabled: true` + an explicit workflow allowlist)
  to have the machine gate also replay its real CI locally, in the same per-task
  worktree, before commit.
- A genuine workflow failure blocks commit exactly like a `success_commands` failure
  does today (worker-fixable → RETRY) — same rigor, not an advisory-only warning.
- An agent-ci/Docker **infrastructure** failure (missing Docker, missing binary, a hung
  run past its timeout) is NOT worker-fixable — it must escalate for operator attention,
  not loop the worker forever on something it cannot fix.
- Zero change to any project that doesn't opt in — the feature is entirely inert unless
  `gate.agentCi.enabled` is set (mirrors `checkCommand`'s existing null-is-a-no-op shape).
- Zero change to the independent critic or to the Decision/escalation type system — this
  folds into the EXISTING `RETRY`/`ESCALATE`/`COMMIT` machinery, not a new one.

**Non-goals (this spec)**
- Auto-discovering/running every workflow in the repo (`agent-ci run --all`) — an
  explicit per-project allowlist only, so a deploy/publish workflow with real secrets
  or side effects is never accidentally executed pre-merge.
- Any UI surface for this (a Project Settings toggle is a natural future follow-up, not
  required for the feature to work — config-file-only for v1, same bar as several other
  gate-adjacent settings today).
- Speeding up a slow CI replay (agent-ci's own `--prewarm-through` already exists for
  this; not this project's problem to solve).
- Any change to how `success_commands`/`checkCommand` behave when this feature is OFF.

## 3. Behavior

### 3a. Where it sits in the pipeline

Today: `worktree → worker → dirty-file fence → critic (retry-loop, breaks on "clean")
→ GATE (checkCommand → success_commands → constitution → zone/guards) → commit`.
agent-ci is a new sub-step **inside GATE**, immediately after `success_commands`
(same position class: a mechanical build/verify check, run before the
constitution/zone-guard logic, which stays human-judgment-only and unchanged).

### 3b. Config shape (per-project, `.autodev/config.yaml`)

```yaml
gate:
  checkCommand: null          # existing field, unchanged
  agentCi:
    enabled: false             # default OFF — fully inert unless explicitly turned on
    workflows: []               # explicit allowlist of workflow file paths, e.g.
                                 # [".github/workflows/ci.yml"] — NEVER auto-discovered
    timeoutMs: 600000           # 10 min default; a hung run is an infra failure (escalate), not a hang
```

An operator who sets `enabled: true` with an empty `workflows` list gets a WARN log at
gate time (nothing configured to run) and the check is skipped that round — mirrors
this project's existing "fail open with a loud warning" convention for a
misconfigured-but-not-broken state (e.g. `policy.heterogeneity`).

### 3c. Two distinct failure branches — the core design decision

1. **A genuine workflow failure** (agent-ci ran fine; the CI job itself failed — a
   lint/test/build step went red): worker-fixable, same class as a `success_commands`
   failure → contributes to the gate's `RETRY` decision, with a reason string per
   failed workflow (`agent-ci workflow '.github/workflows/ci.yml' FAILED`).
2. **An agent-ci/Docker infrastructure failure** (Docker not installed, the `agent-ci`
   binary not resolvable, or the run exceeds `timeoutMs`): this is an
   **operator-config problem**, not something a worker retry can fix. The new gate
   dependency **throws** in this case — reusing the EXISTING `runGate` throw contract
   (`conductor.ts`'s try/catch around `runGate` already escalates any gate throw as
   `"gate threw -- broken operator config"`, see conductor.ts:472-492). Zero new
   escalation code is needed for this branch; it falls straight into machinery that
   already exists for exactly this class of problem (a broken `INVARIANTS.md`/`GUARDS.md`
   throws the same way today).

### 3d. `GateVerdict` shape

A new `agent_ci_green: boolean` field (default `true` when the feature is off or not
applicable), alongside the existing `composer_green`/`success_green` — same convention:
one named boolean per check family, not a single undifferentiated flag, so an operator
reading a verdict can see exactly which check failed.

## 4. Components

- **`src/gate/agent-ci.ts` (new)** — pure-ish module: `runAgentCiWorkflows(input: {
  cwd: string; workflows: string[]; timeoutMs: number; runner: NativeRunner }):
  Promise<{ green: boolean; reasons: string[] }>`. Spawns `npx @redwoodjs/agent-ci run
  --workflow <path> --json` per allowlisted workflow (sequentially — parallel Docker
  runs against the SAME worktree risk exactly the shared-`node_modules`-mount collision
  agent-ci's own `--prewarm-through` docs warn about), parses the NDJSON stream for
  each workflow's terminal `run.finish` event (`status: "passed" | "failed"`). A
  non-zero exit with NO parseable `run.finish` event, or a `runner` promise that never
  resolves before `timeoutMs`, is treated as an infrastructure failure and this
  function **throws** (never returns `{green:false}` for that case — that distinction
  IS the contract callers rely on, per §3c).
- **`src/gate/gate.ts` (modified)** — new optional `GateDeps.runAgentCi: (() =>
  Promise<{ green: boolean; reasons: string[] }>) | null`. New step "1c", right after
  the existing success_commands loop: if present, await it, fold `green` into the
  `RETRY` decision (alongside `composerGreen`/`successGreen`) and append its `reasons`.
  A throw from this dep propagates out of `runGate` exactly like a throwing
  `loadInvariants`/`loadGuardPairs` does today — no new try/catch needed inside
  `gate.ts` itself; the EXISTING caller-side contract (conductor.ts's try/catch) already
  covers it.
- **`src/config/schema.ts` (modified)** — extend the existing `gate` object with
  `agentCi: z.object({ enabled: z.boolean().default(false), workflows:
  z.array(z.string()).default([]), timeoutMs: z.number().int().positive().default(600000)
  }).default({...})`.
- **`src/composition/root.ts` (modified)** — `gateDeps(wt)` gains `runAgentCi`,
  built exactly the way `runCheck` is built today: `null` when `!cfg.gate.agentCi.enabled`,
  else a closure calling `runAgentCiWorkflows({ cwd: wt.path, workflows:
  cfg.gate.agentCi.workflows, timeoutMs: cfg.gate.agentCi.timeoutMs, runner: runNative })`.

## 5. Error handling

- **Empty workflow allowlist while enabled:** WARN + skip (§3c above) — never blocks a
  run on a config the operator hasn't finished setting up.
- **A single workflow in a multi-workflow allowlist fails:** the WHOLE gate step is
  `green: false` (any red workflow blocks commit) with reasons naming every failed
  workflow — mirrors `success_commands`' existing "any command failing fails the
  batch" semantics exactly.
- **Docker not installed / `agent-ci` not resolvable / timeout exceeded:** throws →
  existing conductor escalation path (`"gate threw -- broken operator config"`) — the
  operator fixes the environment, not the worker retrying blindly forever.
- **Sequential workflow execution** avoids the shared-`node_modules`-mount collision
  agent-ci's own docs warn about for parallel cold installs against one working tree.

## 6. Testing / verification

- `src/gate/agent-ci.test.ts`: fake `runner` (mirrors the existing `NativeRunner` fake
  style in `claude-orchestrator-adapter.test.ts`) — a passing NDJSON stream, a failing
  one, a multi-workflow mixed pass/fail, a timeout, and a spawn-failure-throws case.
- `src/gate/gate.test.ts`: extend with `runAgentCi` present+green (COMMIT unaffected),
  present+red (RETRY, reason string included), present+throwing (propagates out of
  `runGate`, matching the existing `loadInvariants`-throws test style), and absent
  (`null`, today's behavior byte-for-byte unchanged — the critical regression guard).
- **Mandatory codex GPT-5.5 gate** on the `gate.ts` diff specifically — this is the
  single most sensitized file in the project (`AGENTS.md`'s review discipline exists
  exactly for changes here).
- **Live-prove required before merge**, not just unit tests: spin up a disposable test
  project with a real minimal `.github/workflows/ci.yml`, enable `gate.agentCi`, drive
  one task through a real gate pass with a workflow that's made to fail (confirm RETRY)
  and one that passes (confirm COMMIT unaffected), plus one deliberately-broken
  Docker/binary scenario (confirm ESCALATE via the existing throw path) — same
  discipline as every prior gate-adjacent live-prove in this project.

## 7. Open questions carried into the implementation plan (not blocking this spec)

- Exact `agent-ci` invocation path (`npx @redwoodjs/agent-ci` vs a pinned/vendored
  install) — a packaging detail for the plan, not a product decision.
- Whether `timeoutMs` needs a lower operator-visible floor (e.g. reject a config value
  under some sane minimum) — a validation nicety to decide during implementation.

## Related

- `docs/wiki/agent-ci-analysis.md` — the recon this spec is the direct follow-up to.
- `docs/FUTURE-BACKLOG.md` "Optional local-CI replay as an extra machine-gate layer" —
  the backlog entry this spec formalizes.
- `src/gate/gate.ts`, `src/conductor/conductor.ts` — the existing, largely-unchanged
  machinery this design is built strictly inside of (new optional dep + new named
  verdict field only; no new Decision/escalation type).
