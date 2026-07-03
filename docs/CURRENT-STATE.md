# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-03 (s16 — **P3 slice 2: UI/UX design gate + multi-project daemon M1–M2 SHIPPED, codex-gated
> clean after 3 rounds (9 findings fixed), merged (PR #30, `6337215`)**: registry + ProjectHub + `/projects/:id` API +
> install-relative UI bundle (closes `[ui/serve-uidir-reporoot]`) + interim UI shim. 537 tests, CI green 4/4.
> **Next: M3 (fs-browser+register+scaffold) → M4 (shell UI per mockup) → M5 (themes); woodev ops-proof still deferred.**)

## Direction (as of s02 — see `adr/002`)

**Not forking AO.** Building our **own Node LTS + TypeScript harness** = headless
daemon (a TS port of our proven autodev-loop) + local web UI, **file-blackboard as the
single source of truth**, assembling the verified best-of from four donors. Skeleton is
**frozen** (6 axes, codex-verified). Mission/discipline unchanged.

## Phase

| Phase | Status |
|---|---|
| P0 — Bootstrap docs & charter | ✅ done (s01) |
| Pivot — build-own vs fork; donor extraction; freeze skeleton | ✅ done (s02, `adr/002`) |
| **P1 — Core loop (headless TS daemon)** | ✅ **DONE (s09).** Behavioral parity with the PS oracle on the fixture (18-scenario parity harness) AND one live real-repo workload (aurora → green COMMIT, live claude+codex) + CI green cross-platform. 272 tests. |
| **adr/003 — role matrix + LLM orchestrator** | ✅ **DONE (s11); LIVE-PROVEN (s12).** R3 role registry (PR #21) + R1/R2 orchestrator layer (PR #22/#23). `orchestrate` proven end-to-end on aurora → green COMMIT `2c77106`, codex critic `clean`, R1 held. 384 tests. |
| **P2 — Web UI (localhost dashboard over the core)** | ✅ **DONE (s14).** Backend (s13, PR #26) + Module 5 UI (s14): agent-desktop React/Vite dashboard → `dist/ui` (own `ui/` workspace) + one gated backend add `GET /escalations/:id`. **LIVE-PROVEN on aurora through the browser** (opus decompose → claude → `php -l` → codex `uncertain` → escalated → A/B reply, all from the composer). 480 tests. |
| **P3 — Product phase (grafts + wrap)** | 🟡 **IN PROGRESS.** Design-gated with operator; decomposed into slices. **Slice 1 — deps-provisioning DONE (s15, PR #29 `dc8b6cd`).** **Slice 2 — UI/UX design + multi-project M1–M2 DONE (s16, PR #30 `6337215`):** spec approved (5 modules), registry + ProjectHub + `/projects/:id` API + install-relative uiDir + UI shim; 3 codex rounds → `clean`, 537 tests, CI green 4/4. **Remaining slices: M3 (fs-browser+register+scaffold), M4 (shell UI per mockup), M5 (themes).** Ops live-proof on a woodev clone still deferred. |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s16, 2026-07-03)

- **UI/UX design gate + multi-project daemon M1–M2 shipped (PR #30 `6337215`).** Operator-resolved forks: full
  multi-project / browser-now-desktop-later / server-side folder browser. Spec `2026-07-03-p3-multiproject-shell-design.md`
  (M1–M5) + mockup `2026-07-03-s16-shell-mockup.html` + plan `2026-07-03-p3-multiproject-m1-m2.md`.
- Built: registry (`~/.autodev/projects.json`, identity-only), `src/composition/root.ts` (extracted `buildProjectRoot`),
  `src/hub/hub.ts` (lazy roots, error isolation), API under `/projects/:id`, per-project single-flight + watchers,
  WS `projectId`, daemon-global `serve` with install-relative uiDir, interim UI shim. 537 tests; codex R1 `broken`(7) →
  R2 `broken`(2) → R3 **`clean`**; CI 4/4. Gotchas: `[ts/shared-promise-reject]`, `[refactor/extraction-eagerness]`,
  `[multiproject/id-keyed-caches]`.

## Prior session (s14, 2026-07-02)

- **P2 Module 5 (dashboard UI) SHIPPED + LIVE-PROVEN on aurora through the browser.** Layout discussed first
  (operator steer: agent-desktop IA — sidebar runs-list + transcript-forward main + inspector rail; critic
  verdict FIRST-CLASS as a "verdict seal"). Built the React/Vite UI in an own `ui/` workspace → `dist/ui`
  (React 19 + Vite + TanStack Router/Query + zustand + Tailwind 4; hand-rolled shadcn-idiom primitives, no
  headless dep; `@fontsource`). Screens: Home (hero + new-run composer), Board (5 queues by attention tone),
  Run transcript, Task detail (2-pane). Live via the existing WS `{type:"change"}` → React-Query invalidate.
  **Reviewed, not codex-gated** (presentation).
- **One gated backend add — `GET /escalations/:id`** (the A/B card needs the escalation body; the only new
  API piece). sonnet TDD → spec-check → **codex GPT-5.5 gate `broken` (4 findings)** → 3 fixed w/ regression
  tests (evidence-fence round-trip, field-borrow, id-match), 1 declined w/ rationale (final-component no-follow
  is consistent with sibling endpoints) → **re-critic `clean`**. 480 tests, typecheck clean.
- **LIVE PROOF (real `serve` on aurora, driven entirely from the browser):** composer → `POST /orchestrate` →
  **opus decompose** (~20s) → 1 task enqueued → **claude worker** → `php -l` gate → **codex critic `uncertain`**
  → escalated → new `GET /escalations/:id` → A/B card + UNCERTAIN verdict seal (real critic notes) → **reply B
  written to the live daemon**. The gate refused to auto-merge an unverified contract claim — the thesis, live.
- Reference-first: donor recon (AO shell/board/inspector + SSE→invalidate; OD run-timeline fold) BEFORE building.
  open-warehouse dropped as a reference (operator: refs live only in `references/`). Serving caveat found:
  `serve` looks for `dist/ui` under the *project* repoRoot (see new gotchas).
- Branch `autodev/s14-dashboard-ui` (also folds in the s13-session-save docs); PR pending.

## Prior session (s13, 2026-07-02)

- **P2 dashboard BACKEND shipped — PR #26 squash-merged → `main` `5a7963a`.** Design-gate first (Plan spec
  `docs/superpowers/specs/2026-07-02-p2-dashboard-design.md`), forks resolved with operator. Stack = open-warehouse's
  (React 19 + Vite + TanStack + shadcn/Tailwind + zustand); transport (keep WS) + run-model (per-run manifest) chosen
  from AO/OD donor recon. 4 modules, each sonnet TDD → spec-check → **codex GPT-5.5 gate → re-critic**: (1) `recordRun`
  run manifest; (2) read endpoints (symlink+size TOCTOU-hardened); (3) `serve`+static (realpath containment for the
  intermediate-symlink-dir escape; 1 documented+accepted TOCTOU residual); (4) `POST /orchestrate` (202-async,
  single-flight, R1-safe thin callback). 447 tests, CI green 4/4. R1 held everywhere.
- New gotcha `[api/static-traversal]`; new feedback memory "check donor refs first on architectural forks".

## Prior session (s12, 2026-07-02)

- **`orchestrate` LIVE-PROVEN end-to-end on aurora → green COMMIT.** 3 live runs (decompose-prompt iteration,
  as the promt predicted). Run 3 (class-docblock intent): opus decompose → clean spec → validate → enqueue →
  trigger → claude worker → gate `php -l` → **codex critic `clean` (0.86)** → **COMMIT `2c77106`** → merge →
  worktree torn down. Task in aurora `done/`. **R1 held** (orchestrator only authored the task file; all
  enforcement in the deterministic conductor). aurora proof branch: `autodev/s12-orch-proof`.
- **Decompose bug found + fixed (branch `autodev/s12-orch-liveproof`, commit `e7dbb46`).** Run 1 escalated
  `dirty-file`: opus emitted `forbidden_paths: ["…/Llm/*", "!…/LlmServiceFactory.php"]` (gitignore `!` negation
  the `*`/`?`/`**` matcher doesn't support) overlapping `file_set` → fence flagged the required file forbidden;
  `validateTaskSpec` had accepted the impossible spec. Fix: superRefine rejects `file_set`∩`forbidden_paths`
  overlap (reuses fence's exact `globMatch` semantics) + decompose-prompt documents glob semantics. sonnet TDD →
  spec-check → **codex GPT-5.5 gate APPROVE (no findings)**. +6 tests, 384 pass / 2 skip. NOT yet merged to `main`.
- Run 2 (`supports()`, post-fix) escalated `uncertain` — critic correctly refused a new public contract with no
  test (dependency-free gate can't run phpunit). The gate working as designed. Gotchas: `[orchestrator/forbidden-paths]`,
  `[orchestrator/bg-spawn-killed]`.

## Prior session (s11, 2026-07-02)

- **R3 role registry SHIPPED (PR #21, merged `d07e72c`).** Flat `worker:`/`critic:` config blocks generalized into
  a unified `roles: {orchestrator, worker, critic, planner}` registry + `policy.heterogeneity` (warn|off). Worker
  keeps its `ladder` (parity §7 intact); orchestrator/planner are config-only (planner reserved, R2). New
  `src/config/roles.ts` (adapter metadata/family/exe resolution, `assertKnownAdapters` fail-loud, heterogeneity
  policy). Root schema `.strict()` (stale flat configs fail LOUD, not silent-revert) + `ladder.min(1)`. All 6
  consumers migrated. codex GPT-5.5 gate: 2 findings fixed + regression tests, 1 declined w/ rationale, re-critic
  clean. typecheck clean, 287 tests, CI green 4/4 (win+linux × node 20/22). aurora `.autodev/config.yaml` migrated.
- **AGENTS.md** added to CLAUDE.md session-start protocol (was missing).
- **R1/R2 orchestrator layer BUILT.** All 5 forks operator-approved ("да по всем") → substrate (PR #22: enqueue
  trust-boundary + read/report caps + R1 import trip-wire) + logic (decompose-only claude/opus adapter + staged
  `handleIntent` pipeline: snapshot→decompose→validate-all-or-nothing→transactional-enqueue→bounded-trigger→report)
  + composition-root wiring & `orchestrate "<intent>"` CLI. R1 held mechanically (orchestrator sees exactly the 4
  caps; `trigger` = bounded `conductor.run` closure, no gate/worker/commit handle). 4 codex gates across the layer,
  all re-critic clean. See `docs/superpowers/specs/2026-07-02-orchestrator-layer-design.md`.

## Prior session (s10, 2026-07-02)

- **`adr/003` design gate passed → accepted.** All 4 open questions resolved with the operator:
  - **R1 boundary — orchestrator STRICTLY ABOVE.** LLM touches enforcement via exactly 4 caps (enqueue task
    file / trigger loop / read state / report+kanban); every step claim→worktree→worker→harvest→fence→critic→
    gate→commit stays in the pure-code conductor. No `run_worker`/`run_critic`/`run_gate`/`commit` tool. Preserves
    the PS-oracle "can't talk past the gate" guarantee 1:1.
  - **R2 planner — folded into orchestrator for MVP**, reserved as a registry role id; output contract = the same
    `queue/pending/*.md` the scheduler understands.
  - **R3 config — unified `roles:` registry** (`{adapter,model,effort?,exe?}` per role) + global defaults + sparse
    per-project override; flat `worker`/`critic` blocks migrate in; `policy.heterogeneity: warn` (default).
  - **R4 orchestrator session/window model — deferred to P2** (window-shaped, over the read-only `api` seam).
- No code this session by design (design gate, not a build sprint). `VISION.md` role-model banner + this file updated.

## NEXT ACTIONS (s17)

1. **M3 — New Project flow (backend, gated).** `GET /fs/dirs` folder browser (dirs-only, git/registered badges,
   hardened per `[api/static-traversal]`), `POST /projects` (validate: exists, git repo, not registered) +
   `DELETE /projects/:id` (registry-only), **scaffold `.autodev/`** (config.yaml from form values + blackboard skeleton
   derived from `src/blackboard/`, `.git/info/exclude` append; never clobber an existing `.autodev/`). Spec §3c/§5/§6/§7;
   write the M3 plan at pickup. Registry write path: reuse `addProject`/`removeProject`/`saveRegistry` (already built+tested).
2. **M4 — shell UI per the mockup** (`docs/superpowers/specs/2026-07-03-s16-shell-mockup.html`, review-only): projects
   sidebar w/ last-5 runs + verdict seals, composer-first project Home, project-scoped routes (`/p/:id/...`), session-
   inspector right rail (Now pipeline / Queue / Session / Roles / Tokens-placeholder), settings screens + footer popover,
   Board as secondary lens. Replaces the T10 shim (`ui/src/components/ProjectGate.tsx`; shim notes: move projectId into
   the router, add projectId dimension to query keys).
3. **M5 — theming:** light token set + System·Dark·Light switcher (client-side persistence).
4. **Ops live-proof of deps-provisioning on a woodev clone (deferred from s15, operator-observed).** Runbook in
   `docs/superpowers/plans/2026-07-02-p3-deps-provisioning.md` Task 9 + gotcha `[worktree/win-junction-follow]`.
5. **Backlog (not blockers):** token/usage instrumentation for the stats rail (phase 2 — adapters emit usage);
   desktop wrap (Electron/Tauri over the same loopback API); `[ui/verdict-not-persisted]`; run rename/archive/fork.

**P2 assets:** backend — `src/api/server.ts` (`/state`, `/runs`, `/runs/:id`, `/tasks/:id/runtime[/:name]`,
`GET /escalations/:id` (s14) + `parseEscalation` in `src/escalate/escalate.ts`, `POST /escalations/:id/reply`,
`POST /orchestrate`, WS, static-serving via `uiDir`); `src/index.ts` `serve` verb + `buildOrchestrator` factory;
`recordRun` in `src/orchestrator/capabilities.ts`. UI — the `ui/` workspace (own package.json, Vite → `dist/ui`;
root `npm run build:ui`/`dev:ui`; `ui/README.md`). Design spec:
`docs/superpowers/specs/2026-07-02-p2-dashboard-design.md` (APPROVED).

**Assets:** all P1 modules under `src/{util,config,blackboard,scheduler,worktree,router,worker,critic,watchdog,
escalate,anti-drift,gate,conductor,api}/` + `src/index.ts` (composition root). Parity harness under
`test/parity/`. CI at `.github/workflows/ci.yml`; asset copy at `scripts/copy-assets.mjs`. The loop runs
end-to-end and is behavior-pinned to the PS oracle on the fixture. Known deferred limits: gotcha
`[conductor/wiring]`.

## Continuity (do not break)

The **existing PowerShell autodev-loop** (`D:/Projects/woodev_framework/tools/autodev/*.ps1`)
keeps running our real tasks until P1 reaches parity. It is the **parity oracle** — untouched.

## Assets on disk

- `references/` — 5 donor clones (git-ignored; URLs + pinned SHAs in `references/MANIFEST.md`).
  Note gotcha: OpenHands real code is in `references/software-agent-sdk/`.
- `docs/superpowers/donor-extraction/` — 5 briefs, `decision-matrix.md` (VERIFIED),
  `codex-verification.md`, `autodev-loop-parity-spec.md`.
- `docs/superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — the P1 design.

## Open questions

- ✅ **RESOLVED (s10) → `adr/003` ACCEPTED.** Role model = configurable matrix + LLM orchestrator.
  Answers: (R1) orchestrator sits **strictly above** the pure-code conductor — 4 caps only
  (enqueue/trigger/read/report), enforcement steps un-bypassable; (R2) `planner` **folded into the
  orchestrator for MVP**, reserved as a registry role, output = `queue/pending/*.md`; (R3) unified
  **`roles:` registry** (`{adapter,model,effort?,exe?}`) + global defaults + sparse per-project
  override + `policy.heterogeneity: warn`; (R4) orchestrator window/session model **deferred to P2**.
  Build order: role registry/config first (s11), then the orchestrator layer.
- ✅ **RESOLVED (s05) → (b).** Gate/recipe design: confirmed from real `.autodev/GUARDS.md` + recipe files
  that the table's `contract_value` cell is human-facing (can list `+`-joined siblings; yandex row lists two
  values but the recipe carries one `canonical_value`) while the machine per-value key is `recipe.canonical_value`,
  and `zone_id` lives ONLY in the recipe. `guards.ts` = pure fs-free table parser + selectors over enriched
  `GuardRecipePair[]`; `gate.ts` owns recipe loading (mirrors PS `Get-AutodevGuards` + `Get-AutodevGuardRecipePairs`
  + pure `Select-*`). Matching the raw `contract_value` cell would have falsely covered a sibling value —
  (b) is required for divergence-#2 correctness, not just cleaner.
- ✅ **RESOLVED (s09).** Live P1 parity target = `aurora` (disposable Laravel sandbox in `d:/projects/`,
  operator-designated as abandoned/deletion-candidate → free to use). Green COMMIT proven end-to-end.
- Repo hosting/licensing details for `kalbac/autodev-harness`.
- Exact per-project config file format (`.autodev/config.yaml` vs `harness.config.*`).

## Related
- `adr/002-build-own-harness-not-fork-ao.md` — the pivot (supersedes `adr/001`).
- `superpowers/specs/2026-07-01-harness-p1-core-loop-design.md` — P1 design.
- `superpowers/donor-extraction/decision-matrix.md` — the verified basis.
