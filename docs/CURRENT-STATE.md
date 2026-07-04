# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-04 (s24 — **critic-verdict.json persistence + committed-task verdict seal LANDED (PR #43,
> squash `b9b87f9`).** Conductor now writes a per-task `critic-verdict.json` runtime artifact at the DECISIVE point of
> a task (clean-commit or parseable escalation, never an intermediate retry round → no stale artifact), best-effort/
> never-throws like s22's token-usage; the UI Inspector Verdict tab reads it (404-tolerant `useTaskVerdict`) and renders
> the REAL persisted verdict (confidence + notes + broken_contracts via the reused `VerdictSeal`) for a committed task,
> closing gotcha `[ui/verdict-not-persisted]`. **codex GPT-5.5 gate — 3 findings: 2 Medium (stale-artifact → decisive-
> only placement fix; clock-determinism → declined w/ rationale), 1 Low (throwing-logger test) → re-critic behavior
> CLEAN.** 671 tests (+9), CI 4/4, browser-smoke proven (`clean · 0.92 · persisted notes`). 1 new gotcha
> `[conductor/per-round-overwrite-stale]` (35). Prior: s23 —
> **run rename + archive + UI re-run LANDED (PR #42, squash `53d2ced`).** New
> `PATCH /projects/:id/runs/:runId` (rename `name` / soft-archive `archived_at`) + `GET /runs?includeArchived`;
> the run manifest is a non-authoritative index so these touch ONLY the manifest file. Fork dropped as a backend
> verb (donors fork a conversation/event-stream we lack) → UI-only "re-run" (seed the composer). Full TDD →
> **codex GPT-5.5 gate (3 defects across 2 rounds — TOCTOU symlink-follow, trim-before-length mutate-on-reject,
> short-write — all fixed → re-critic clean)** → 662 tests, browser-smoke drove the whole flow. Prior: s22 —
> **token/usage instrumentation LANDED (PR #41, squash `675baf0`) — the first real module after P3.** Worker (claude stream-json `result.usage`) + critic (codex bare `tokens used` footer, best-effort)
> adapters expose usage; conductor persists a per-task `token-usage.json` runtime artifact (best-effort/never-throws);
> the Tokens rail drops its phase-2 placeholder and aggregates the newest run's tasks on the client via the EXISTING
> runtime-file endpoint (no new API code). Full TDD → **independent codex GPT-5.5 gate (1 Medium found+fixed → re-critic
> clean)** → 654 tests, CI green 4/4, browser-smoke proven (`52.4k · $0.0473`). Prior: s21 woodev deps-provisioning
> ops-proof → P3 loop proven end-to-end (green COMMIT `912ef64`). **P3 CLOSED; no operator-gated items remain.**)

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
| **P3 — Product phase (grafts + wrap)** | 🟡 **IN PROGRESS.** Design-gated with operator; decomposed into slices. **Slice 1 — deps-provisioning DONE (s15, PR #29).** **Slice 2 — multi-project M1–M2 DONE (s16, PR #30).** **M3 New Project backend DONE (s17, PR #31 `7c80a90`):** `/fs/dirs` + `POST`/`DELETE /projects` + `.autodev` scaffold, codex R1 broken→re-critic uncertain→**clean**. **M4 product shell UI DONE (s17, PR #32 `c121a05`):** projectId-in-router, multi-project sidebar, composer Home, session rail, New Project screen + gated `GET /projects/:id/config`; browser-live-proven E2E. **M4-7 settings + M5 light theme DONE (s18, PR #34 `75f9675`, review-only):** Global + project settings screens replace the placeholders; `[data-theme="light"]` token set completes the switcher; browser-proven both themes + real E2E unregister. **Backlog polish DONE (s19):** rename endpoint (PR #36), config-write endpoint + editable project settings (PR #37, codex found+fixed 2 blockers), composer project-switcher real menu (PR #38). 633 tests, CI green 4/4. **Backlog polish continued (s20):** Project Settings edit mode extended to every role field (PR #40, review-only). **woodev deps-provisioning ops-proof LANDED (s21):** real woodev clone provisioned (`vendor`+`plugins-reference` junctions) → harness `run --once` → real static gate `composer check:static` (phpcs+phpstan) GREEN in worktree → **COMMIT `912ef64`** → safe teardown. **P3 CLOSED end-to-end; no operator-gated items remain.** **Post-P3 — token/usage instrumentation LANDED (s22, PR #41 `675baf0`):** worker/critic adapters expose usage → conductor persists per-task `token-usage.json` (best-effort) → Tokens rail aggregates on the client; codex-gated (1 Medium fixed → re-critic clean), 654 tests, browser-smoke proven. **Run rename + archive + UI re-run LANDED (s23, PR #42 `53d2ced`):** `PATCH /runs/:id` (rename/soft-archive, manifest-index only) + `GET /runs?includeArchived` + RunView actions bar; codex-gated (3 defects fixed → re-critic clean), 662 tests, browser-smoke proven full flow. **critic-verdict.json persistence + committed-task verdict seal LANDED (s24, PR #43 `b9b87f9`):** conductor writes a per-task `critic-verdict.json` at the DECISIVE point (clean-commit / parseable escalation, never intermediate rounds), best-effort; UI Inspector Verdict tab reads it (404-tolerant) and shows the REAL verdict+confidence+notes for a committed task (closes `[ui/verdict-not-persisted]`); codex-gated (2 Medium + 1 Low, decisive-only fix + reasoned decline → re-critic CLEAN), 671 tests, browser-smoke proven. |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s24, 2026-07-04)

- **critic-verdict.json persistence + committed-task verdict seal SHIPPED & MERGED (PR #43, squash `b9b87f9`).** The
  recommended opener from the s24 promt — closes gotcha `[ui/verdict-not-persisted]`. A CLEAN-committed task never
  escalates, so its verdict lived only in a digest line; now it has a first-class readable artifact.
- **Backend (codex-gated).** New pure `buildCriticVerdictDoc` + `CriticVerdictDoc` in `src/critic/verdict.ts`
  (exactOptional-safe `diff_sha256` omission). New best-effort/never-throws `persistCriticVerdict` closure in the
  conductor, written ONLY at a task's DECISIVE point — before the clean `break` (commit) and inside the escalate branch
  guarded `if (cr.verdict)` — NOT on intermediate retry rounds. Mirrors s22's `persistTokenUsage` never-throws contract
  (`safeLog`, `[ts/fail-closed]`); served unchanged by the existing runtime-file endpoint (no new API code).
- **codex GPT-5.5 gate — 3 findings:** (1) Medium stale-artifact — the FIRST cut persisted every round, so a
  `parseable→retry→null→escalate` sequence left the earlier verdict stale → FIXED by decisive-only placement (intermediate
  rounds never write, so a valueless final round leaves no artifact) + regression test; (2) Medium clock-determinism
  (extra `clock.now()`) → DECLINED w/ rationale (prod clock side-effect-free; same pattern as gated s22 persistTokenUsage;
  the parity #9 `nowCalls` 3→4 shift crosses no decision boundary — graceful exit preserved); (3) Low throwing-logger
  coverage → ADDED. **Re-critic: behavior/control-flow CLEAN** (one residual doc-comment "each round" fixed).
- **UI (review-only).** `CriticVerdictDoc` type + 404-tolerant `useTaskVerdict` hook (mirrors `useRunUsage`). Inspector
  `VerdictTab` prefers the REAL persisted verdict (confidence + notes + broken_contracts via the reused `VerdictSeal`)
  over the state-synthesized placeholder; falls back to synthesis for undecided tasks / pre-s24 runs.
- **Verification.** 671 tests (+9: 3 builder, 4 conductor, +2 regression), typecheck green (root+ui), CI 4/4. Parity #9
  `nowCalls` 3→4 (documented benign). **Browser-smoke** on a seeded scratchpad serve: the Verdict tab of a committed
  task rendered `clean` + confidence `0.92` + the persisted notes (vs the old fabricated placeholder). Screenshot sent;
  seed + daemon torn down. Self-merged after operator's explicit "мёржи" (auto-mode classifier blocked the standing
  memory-based autonomous merge — a mechanical gate, resolved by the operator's one-word in-session OK).
- 1 new gotcha `[conductor/per-round-overwrite-stale]` (count 34→35). The clock-determinism decline is a code-review
  judgment, not a gotcha.
- main tip = `b9b87f9`. This docs commit rides with the next PR (batch-merges). Working tree clean.

## Prior session (s23, 2026-07-04)

- **Run rename + archive + UI re-run SHIPPED & MERGED (PR #42, squash `53d2ced`).** Backlog item (NEXT ACTIONS #3,
  was unscoped) — designed WITH the operator after a **donor recon** (AO/OD/OpenHands run/session lifecycle). Recon
  reshaped the design: AO has no run fork; OD/OpenHands fork a *conversation/event-stream* we don't have; our run
  manifest is a **re-derivable index** over the blackboard queue → a real "fork" ≈ re-orchestrating the same intent.
  So: rename + archive as backend verbs, **fork → UI-only "re-run"** (seed the composer, no backend fork).
- **Backend (codex-gated).** `RunManifest` +`name?`/`archived_at?` (`recordRun` unchanged, forward-compatible;
  `isRunManifest` type-validates the optionals). Pure `applyRunPatch`. `GET /runs?includeArchived=1` (default hides
  archived — reversible soft-flag, AO's pattern). `PATCH /projects/:id/runs/:runId` — bounded read (404 on
  missing/corrupt) + **hardened no-follow write** (`lstat` + `O_RDWR|O_NOFOLLOW` open, no `O_CREAT` so a vanished
  target 404s not resurrects, + `fstat` + `truncate(0)` + `fh.writeFile`). Touches ONLY the manifest index — never
  the queue/tasks/worktrees/gate.
- **codex GPT-5.5 gate — 3 defects across 2 rounds, all fixed → re-critic clean:** (1) High `lstat`→`writeFile`
  TOCTOU symlink-follow → no-follow open; (2) Medium name length checked AFTER `trim` (a 201-space name silently
  CLEARED an existing name) → raw-length check + regression test; (3) Medium `fh.write` short-write risk →
  `fh.writeFile` (loops). Windows `EINVAL` on `O_WRONLY|O_TRUNC` without `O_CREAT` found empirically → `O_RDWR` +
  `truncate(0)`.
- **UI (review-only).** `name ?? intent` everywhere a run is labelled (HomeView card, sidebar, RunView header).
  `RunView` actions bar (inline rename, archive/unarchive toggle, re-run via a zustand seed store). `HomeView`
  "show archived" toggle + a muted archived tag.
- **Verification.** 662 tests (+10 backend), typecheck+build green (root+ui). **Browser-smoke** on a seeded serve
  drove the whole flow: rename → archive (default list hides) → `?includeArchived` shows → unarchive → re-run
  (composer pre-filled + navigate home) → HomeView show-archived toggle. Screenshot sent; seeded project + daemon
  torn down. Self-merged (machine bar). **Gotcha caught mid-build:** UI-only build (`build:ui`) leaves the served
  `dist/index.js` STALE — a new backend route 404s until a root `npm run build`; always rebuild BOTH before a live smoke.
- 1 new gotcha `[build/stale-dist-backend]` (a UI-only `build:ui` leaves the served daemon stale → live-smoke 404s;
  count 33→34). The codex findings themselves are code-review catches, not repeated-mistake gotchas.
- main tip = `53d2ced`. This docs commit rides with the next PR (batch-merges). Working tree clean.

## Prior session (s22, 2026-07-04)

- **Token/usage instrumentation SHIPPED & MERGED (PR #41, squash `675baf0`) — the next real module after P3 closed.**
  Operator scope-gated at session start (per-task runtime file + client-side aggregation by run). Full
  worker→spec-check→codex-gate→re-critic discipline (enforcement-adjacent adapters + conductor).
- **Backend (codex-gated):** new pure `src/usage/usage.ts` (`WorkerUsage`/`CriticUsage`/`TokenUsageDoc` +
  `parseClaudeUsage` last stream-json `result` event / `parseCodexTokens` line-anchored footer / `buildTokenUsageDoc`).
  `WorkerResult.usage?` parsed in `claude-adapter.toResult`; `CriticResult.usage?` in `codex-adapter` (plain `codex
  exec` KEPT — not switched to `--json` — so the enforcement verdict path is untouched; critic yields a single `tokens`
  total). Conductor accumulates worker+critic usage per round → writes `token-usage.json` best-effort/never-throws
  (`[ts/fail-closed]`), served UNCHANGED by the existing runtime-file endpoint (no new API code — the key scope win).
- **codex GPT-5.5 gate:** 1 Medium — `parseCodexTokens` loose-matched "tokens used" anywhere in stdout → false
  telemetry from prose like "No tokens used ... finding 3". Fixed = LINE-ANCHORED footer parse (whole trimmed line
  must be the footer) + 3 regression tests. **Re-critic clean** (no residual). Nothing else merge-blocking.
- **UI (review-only):** `SessionRail` Tokens block drops the `phase 2` placeholder; new `useRunUsage` hook sums the
  newest run's per-task `token-usage.json` on the client (404-tolerant). `formatTokens`/`formatCost` helpers.
- **Verification:** 654 tests (+19), typecheck+build green (root+ui), CI 4/4. **Browser-smoke** on a seeded serve
  (scratchpad project, port 7822): rail rendered `this run 52.4k · cost $0.0473`; a task with no usage file (404) was
  tolerated and excluded from the sum. Screenshot sent to operator. Seeded project + daemon cleaned up after.
- No new gotchas (the `parseCodexTokens` lesson is a code-review catch, not a repeated-mistake gotcha; count stays 33).
- main tip = `675baf0`. This docs commit rides with the next PR (batch-merges). Working tree clean.

## Prior session (s21, 2026-07-04)

- **woodev deps-provisioning ops-proof LANDED — the whole P3 loop is now proven end-to-end on a real,
  production-shaped project.** Operator on `/remote-control` chose the operator-gated ops-proof and observed.
- **Setup:** local `git clone` of `woodev_framework` → `D:/Projects/woodev-harness-clone` (disposable), branch
  `autodev/s21-proof`. Untracked `.autodev` + `.serena` (MCP churn) via `.git/info/exclude` so runtime/MCP writes
  never dirty the merge tree. Copied the gitignored `vendor` (76M) + `plugins-reference` (17M) from the original.
  Bumped the clone's phpstan `--memory-limit` 2G→4G (base phpstan crashed a parallel worker at 2G — an env wrinkle,
  not a code defect: `[OK] No errors` at 4G). `.autodev/config.yaml`: `gate.checkCommand`,
  `worktree.provision: [vendor, plugins-reference]`, roles (worker claude/sonnet, critic codex/gpt-5.5/high).
  Task = a class-level PHPDoc on `woodev/box-packer/abstract-class-packer.php` (docs, non-contract-zone).
- **Result (green COMMIT):** harness `run --once` (detached, cwd=clone) → worktree created with BOTH deps as NTFS
  junctions → worker (sonnet) wrote the docblock → critic (codex/gpt-5.5) `clean` 0.88 → gate `composer check:static`
  (phpcs+phpstan) ran **GREEN in the worktree on the provisioned deps** → `gate-verdict.json` `composer_green:true
  decision:COMMIT` → **COMMIT `912ef64`** → deprovision (link-only) → safe teardown. Main `vendor` intact, original
  `woodev_framework` untouched, tree clean.
- **KEY FINDING → gotcha `[worktree/vendor-junction-autoload-basedir]`.** The first attempt used the full
  `composer check` (phcs+phpstan+**phpunit**) and RETRY'd on exit 255: phpunit EXECUTES the framework (loads a real
  plugin fixture through the resolver), and because `vendor` is a junction, PHP resolves `__DIR__` inside Composer's
  autoloader to the junction's REAL target → `$baseDir` = the main clone → project classes autoload from the main
  clone while worktree-relative `require_once` loads the worktree copy → `Cannot redeclare class`. phpcs/phpstan (read
  by path) are unaffected — hence the static gate for the green run. A runtime phpunit gate would need per-worktree
  `vendor` materialization (real copy or autoloader regen) — backlog.
- **Also re-confirmed `[worktree/win-junction-follow]` live** (the hard way): a NON-link-safe manual repro cleanup
  (bash `rmdir` on a live junction — which fails and leaves it — then `git worktree remove --force`) followed the
  junction and wiped the disposable clone's real `vendor/`. The harness's OWN teardown did it safely every time
  (link-only deprovision logged before recursive removal). Lesson reinforced: never bash-`rmdir` a live junction; use
  PowerShell `(Get-Item link).Delete()` / the harness `removeLinkOnly`.
- 1 new gotcha (`[worktree/vendor-junction-autoload-basedir]`, count 32→33). main tip advances with this docs commit.

## Prior session (s20, 2026-07-04)

- **Operator went to sleep at session start, granted full autonomy** ("работай автономно... мержи, пушь"). Skipped
  the operator-gated woodev ops-proof entirely (untouched); picked the lowest-risk, best-scoped remaining backlog
  item by judgement.
- **PR #40 — Project Settings edit mode extended to every role field**, closing the note left in s19 ("roles.*
  scoped out of the first cut"). Backend already accepted `roles.orchestrator.{adapter,model,effort}`,
  `roles.worker.adapter`, `roles.critic.{adapter,model,effort}` via `ScaffoldFormSchema` since PR #37 — this was
  UI-only: 7 new `TextFieldRow`s in `ProjectSettingsView.tsx`, `buildDiff`/`addIfChanged` extended to send only
  the per-role sub-fields that actually changed (mirrors the established `checkCommand` non-empty-only-send
  convention). Review-only (pure presentation, no conductor touch). typecheck + build clean.
  **Browser-live-proven on the REAL aurora sandbox**: edited `roles.orchestrator.model` via the UI, confirmed the
  live `GET /projects/:id/config` projection updated immediately (hub-evict from s19 still holding), reverted via
  a second UI edit. Independent codex GPT-5.5 review: no blockers (one flagged concern didn't apply —
  `critic.effort` is non-optional in `ProjectConfigView`; the other is pre-existing trim behavior already shipped
  for `checkCommand` in s19, not a new regression). CI green 4/4, self-merged. 633 tests (unchanged — UI has no
  test suite by convention, browser-proof stands in).
- **Scoped (not built) token/usage instrumentation for s21**, per the size/design-uncertainty tradeoff below —
  see NEXT ACTIONS #1 for the findings.
- No new gotchas this session.
- main tip = `565bab2`. Working tree clean at session end.

## Prior session (s19, 2026-07-04)

- **3 P3 backlog items shipped & merged** (operator away most of the session, auto-mode; woodev ops-proof stayed gated,
  untouched). Full worker→spec-check→codex-gate→re-critic→self-merge discipline throughout.
- **PR #36 — `PATCH /projects/:id` rename.** Registry `name` only; `id`/`path` immutable (id-keyed caches stay valid).
  `renameProject` pure fn → `admin.rename` (same `withLock` mutex as register/unregister) → routed before root-resolve
  (like DELETE). codex clean; 2 minor test-coverage gaps closed with regression tests. 612 tests. Browser-live E2E (API
  all paths + UI inline rename with sidebar re-fetch).
- **PR #37 — `PATCH /projects/:id/config`** (project settings editable in UI, closing the "config-write is the natural
  next step" note from s18). `mergeConfigYaml` merges into the EXISTING raw config so hand-set fields the form doesn't
  cover survive; `hub.evict(id)` on write success — otherwise the LIVE daemon keeps running the stale gate/role config
  after a successful write (found during design, not by codex — a real threat to "never merge bullshit"). **codex found
  2 blockers:** (1) `config.yaml` itself wasn't symlink-guarded (only `.autodev` dir was) — fixed + regression test; (2)
  claimed `hub.evict` in-flight-build race — investigated against the FULL `get()` control flow, found NOT reproducible
  (success path never re-writes the map after its await), codex confirmed on re-review with an explicit call-sequence
  check. Re-critic clean. 633 tests. **Browser-live-proven on the REAL aurora sandbox** (not a fixture): edited
  `roles.worker.ladder` via the UI, confirmed hand-set `roles.critic.{adapter,model,effort}`/`gate.checkCommand`
  survived untouched in the actual committed file, then reverted via a second UI edit.
- **PR #38 — composer project-switcher** — real dropdown (`ProjectSwitcherMenu`) replacing the static chip; picking a
  project navigates to its home. Pure frontend, review-only. Browser-live E2E.
- Ran the daemon live for the operator mid-session; he independently registered a REAL project
  (`woodev-shipping-plugin-test`) via the New Project flow while watching — left untouched.
- 3 new gotchas: `[hub/evict-on-config-write]`, `[scaffold/config-file-symlink]`, `[config/yaml-merge-drops-comments]`.

## Prior session (s18, 2026-07-04)

- **P3 product shell CLOSED — M4-7 settings + M5 light theme shipped & merged (PR #34 `75f9675`, review-only static UI).**
  Global `/settings` (`GlobalSettingsView`): Appearance (theme control), Projects registry (list + two-step unregister via
  `useDeleteProject`, live list invalidation), Daemon info (conn/host/count). Project `/p/:id/settings`
  (`ProjectSettingsView`): read-first projection over `GET /projects/:id/config` (repo/gate/branch/provision/roles) + a note
  that editing stays file-based. Shared `SettingsLayout` kit (page/section/row). Router: real views replace the two
  placeholders. AppShell: `/settings` excluded from the session-rail predicate.
- **M5:** `[data-theme="light"]` override block in `ui/src/styles.css` remaps the chrome (ink/panel/surface/line/text);
  status+verdict hues stay shared. Completes the System·Dark·Light switcher (`lib/theme.ts`).
- **Browser-live-proven** (Playwright, seeded registry = aurora real config + a defaults project): both screens in dark +
  light, theme persists, and a **real end-to-end unregister** (registry file + sidebar + count all updated). typecheck clean,
  CI green 4/4. Independent code-review pass: ship-ready, 2 sub-threshold polish notes applied.
- **Permission friction fixed at the root:** the auto-mode classifier keeps denying `gh pr merge` ("[Merge Without Review]")
  because there was no `permissions.allow` rule. Agent **cannot self-write** one (that's also classifier-blocked as
  "[Self-Modification]"), so the operator created `.claude/settings.json` with `Bash(gh pr merge:*)` (+ create/checks/view).
  Memory sharpened: a classifier merge-deny is a mechanical blocker to retry, NEVER a fork to route to the operator.
- New gotchas: `[registry/json-win-backslash]`, `[ui/light-theme-tokens]`.

## Prior session (s17, 2026-07-03/04)

- **M3 New Project backend + M4 product shell UI both shipped & merged** (PR #31 `7c80a90` codex-gated clean; PR #32
  `c121a05` review-only + gated config endpoint). The daemon is a real multi-project product now.
- **M3:** `GET /fs/dirs` folder browser, `POST`/`DELETE /projects`, `.autodev` scaffold (validated-config-before-write,
  `wx` stubs, idempotent git-exclude, symlink-escape guarded). codex R1 broken(4)→symlink fix→re-critic uncertain
  (child-symlink residual)→fixed→**clean**. Windows CI 8.3-realpath divergence caught+fixed.
- **M4:** projectId-in-router (`/p/:id`), M3 api hooks, gated `GET /projects/:id/config`, multi-project sidebar (run
  seals + settings popover + theme), composer Home + top bar, session rail (Now/Queue/Session/Roles/Tokens), New Project
  screen. **M4-7 settings deferred** (placeholder routes). Browser-live-proven E2E (register a fresh repo from the UI →
  scaffold on disk → drivable shell). 596 tests, CI green 4/4. Gotchas: `[ci/win-83-realpath]`, `[scaffold/symlink-escape]`.
- **Autonomy sharpened:** agent owns ALL git+GH incl. merges — self-merge on machine-bar+green-CI, never wait; interrupt
  operator only at 100%-his forks (`AGENTS.md` + memory updated).

## Prior session (s16, 2026-07-03)

- **UI/UX design gate + multi-project daemon M1–M2 shipped (PR #30 `6337215`).** Full multi-project / browser-now /
  server-side folder browser (operator forks). registry + `src/composition/root.ts` (`buildProjectRoot`) + `src/hub/hub.ts`
  (lazy roots) + API under `/projects/:id` + WS `projectId` + install-relative uiDir + interim UI shim. codex R1 `broken`(7)
  → R2(2) → R3 **`clean`**; 537 tests, CI 4/4. Gotchas: `[ts/shared-promise-reject]`, `[refactor/extraction-eagerness]`,
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

## NEXT ACTIONS (s25)

**P3 is CLOSED; three post-P3 modules LANDED — token/usage (s22, PR #41), run rename/archive+re-run (s23, PR #42),
and critic-verdict.json persistence + committed-task verdict seal (s24, PR #43).** The product shell is complete
(register → scaffold → drive → settings → theme), s19+s20 closed 4 backlog items, s21 landed the deps-provisioning
ops-proof. **No operator-gated items remain.** Everything below is backlog polish or an optional follow-up; pick with
the operator UNLESS granted autonomy, then take the best-scoped item.

**Recommended opener candidates for s25:** (a) **desktop wrap (Electron/Tauri over the loopback API)** — the biggest
remaining stretch item, additive (the daemon already serves install-relative); needs an IA/UX discussion with the
operator before building. (b) **server-side usage aggregation** `GET /runs/:id/usage` for a cross-run "today" total
(s22 deliberately did client-side per-run only). (c) **codex critic `--json`** for an input/output token split + cost
(would need to re-verify the stdout-shape dependency — gate carefully). No single obvious must-do; discuss.

-1. **~~critic-verdict.json persistence + committed-task verdict seal~~ — DONE (s24, PR #43 `b9b87f9`).** Conductor
   writes a per-task `critic-verdict.json` at the decisive point (clean-commit / parseable escalation, never intermediate
   rounds → gotcha `[conductor/per-round-overwrite-stale]`); UI Inspector Verdict tab renders the real persisted verdict
   for a committed task (closes `[ui/verdict-not-persisted]`). Possible follow-up only if asked: also persist for
   quarantine tasks / surface the verdict seal in RunView task cards (currently only the Inspector rail).

0. **~~Run rename / archive / fork~~ — DONE (s23, PR #42 `53d2ced`).** `PATCH /runs/:id` (rename `name` / soft-archive
   `archived_at`, manifest-index only) + `GET /runs?includeArchived` + RunView actions bar (rename/archive/re-run).
   Fork was intentionally NOT built as a backend verb (re-run = UI seed of the composer covers the 80%). Possible
   follow-ups only if asked: a hard-delete for a run manifest (archive is reversible today); `forkedFrom` lineage (only
   meaningful with a real backend fork). See `docs/superpowers/specs/2026-07-04-run-rename-archive.md`.
1. **~~Token/usage instrumentation~~ — DONE (s22, PR #41 `675baf0`).** Per-task `token-usage.json` (worker
   stream-json usage + critic bare-footer tokens) written best-effort by the conductor; Tokens rail aggregates the
   newest run on the client via the existing runtime-file endpoint. Possible follow-ups if the operator wants richer
   telemetry: (a) a "today"/cross-run cumulative (dropped from s22 — a session rail would need N×M fetches; a small
   server aggregation endpoint `GET /runs/:id/usage` would be the clean way if it's wanted); (b) switch the codex critic
   to `--json` for an input/output token SPLIT + cost (s22 kept plain `codex exec` to avoid destabilizing verdict
   resolution — would need to re-verify the stdout-shape dependency); (c) persist the deferred `critic-verdict.json`
   (`[ui/verdict-not-persisted]`) alongside token-usage now that the conductor writes a per-task JSON artifact anyway.
2. **Deps-provisioning phpunit-gate follow-up (optional, backlog).** The s21 ops-proof proved a static gate
   (`composer check:static`) on a junction-provisioned `vendor`; a full runtime gate that runs phpunit fatals in the
   worktree — `[worktree/vendor-junction-autoload-basedir]`. To support a phpunit gate, materialize `vendor` per-worktree
   (a real copy, or `composer dump-autoload` regenerated with the worktree as `$baseDir`) instead of a junction. Real
   scope (defeats the zero-copy point); only worth it if a project's gate genuinely needs runtime tests. Not needed for
   static-analysis gates.
3. **Backlog polish (any, review-only unless it touches the conductor):**
   - desktop wrap (Electron/Tauri over the loopback API — additive, the daemon already serves install-relative).
     Likely the biggest remaining stretch item now that the run-management verbs are done.
4. **Light-theme follow-up (only if a light surface renders a verdict tone as TEXT):** add light-tuned darker status hues
   under `[data-theme="light"]` — see gotcha `[ui/light-theme-tokens]`. Not needed for current screens.

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
