# SESSION LOG — Autodev Harness

> Newest entry on top. 10–20 lines per session.

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
