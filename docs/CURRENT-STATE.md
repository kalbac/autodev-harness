# CURRENT STATE — Autodev Harness

> ## ✅ s38 — **agent-ci observability BUILT + codex-CLEAN + LIVE-PROVEN end-to-end through the daemon+browser** (happy DONE+commit AND red RETRY), branch `autodev/s38-agent-ci-observability`
> Executed the s38 plan (`docs/superpowers/plans/2026-07-11-agent-ci-observability.md`) subagent-driven (Sonnet workers +
> spec/quality review per module + mandatory codex GPT-5.5 gate). Makes the off-by-default `gate.agentCi` step **cross-platform
> + observable**: streaming refactor of `agent-ci.ts` (buffered→line-by-line typed `AgentCiEvent`), **WSL-proxy invocation on
> Windows** (`detectAgentCiCapability`→native/wsl/unavailable; `winToWslPath`), persist `agent-ci-events.ndjson`+`agent-ci-status.json`
> + an in-memory `CiEventBus` + SSE (`GET /ci/:taskId/stream`, history-replay→live) + `GET /ci/capability`, a **CI block in
> SessionRail** (enabled-gated) + a **live `CiRunView` step-tree screen** + a **Settings capability line**, and an honest
> `AgentCiUnavailableError("needs-wsl-on-windows")` escalation reason. Verdict/decision semantics UNCHANGED from v1.
> **Gate: 981 tests/3 skip, typecheck+build(root+ui) green; codex GPT-5.5 ran 4 passes — backend R1 found 1 Critical (timeout
> passed after a terminal event) + 2 High (WSL path never mapped — `winToWslPath` was dead code! + unmappable≠unavailable) + 2
> Medium (SSE replay-disconnect leak; unbounded ndjson) → fixed; R2 found 1 Medium (cap off-by-marker) → fixed; the two
> live-prove git-fixes → CLEAN.** **LIVE-PROVEN through the REAL daemon + Chrome** on `agentci-live4` (WSL+Docker): a real task
> ran opus-decompose → sonnet-worker → gate(check + **agent-ci full CI in WSL, 6/6 steps passed**) → codex-critic clean → COMMIT
> → merge → **DONE with a real commit `565b93c` on autodev/main**; the CI screen streamed the green step-tree live ("agent_ci_green
> ✓ → gate COMMIT unaffected"); Settings showed "agent-ci ● VIA WSL". Red path proven too (`agentci-red`, failing workflow): CI
> screen red tree with `failing-check` red + "agent_ci_green ✗ → gate RETRY (failed: failing-check)" + CI block "failed (step …)".
> **The live-prove earned its keep AGAIN** — it found TWO Windows↔WSL git-interop blockers unit tests could never see (agent-ci
> couldn't resolve HEAD in a Windows-created worktree; agent-ci corrupts the shared `.git/config`), both fixed → **GOTCHAS 57→58**
> (`[gate/agent-ci-worktree-wsl-git-interop]`). **NEXT: operator reviews → codex `/code-review` full-branch (optional) → one PR →
> merge.** honest-unavailable path is unit-proven + same machinery (this box has WSL, so not driven live).
>
> ## ✅ s37 — **agent-ci gate hardening SHIPPED** (optional local-CI-replay gate step), codex-CLEAN + LIVE-PROVEN end-to-end → **PR #69**
> Implemented the s33 spec (`docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md`) subagent-driven (Sonnet
> workers + mandatory codex GPT-5.5 gate). An **optional, off-by-default, config-gated ADDITIONAL** machine-gate step replays
> a project's real GitHub Actions CI locally (`@redwoodjs/agent-ci`) in the per-task worktree BEFORE commit. **Inert unless
> `gate.agentCi.enabled:true` + explicit workflow allowlist** (never `run --all`). Job-fail → RETURN `{green:false}` → folds
> into the gate's existing **RETRY**; agent-ci/Docker infra-fail (no Docker/binary/terminal-event/timeout) → **THROWS** →
> propagates out of `runGate` → existing conductor try/catch **ESCALATES** (`gate threw -- broken operator config`; zero new
> escalation code). New step "1c" after `success_commands`; new verdict field `agent_ci_green`; never replaces the critic,
> never mandatory, no UI (config-file only). Touched `gate.ts` (most sensitive) + `agent-ci.ts` (new) + `schema.ts` + `root.ts`.
> **Gate: 934 tests/3 skip, typecheck+build(root+ui) green; codex GPT-5.5 gate ran 3 rounds** — R1 found 2 Sev-2 (timeout
> didn't kill the child→leak; parser OR'd terminal events→late `cancelled` after `passed` misread as pass) → fixed (child-kill
> via `runNative.timeoutMs`; last-terminal-wins + fail-closed) → re-critic CLEAN; then the **live-prove found a real correctness
> bug** (below) → fixed → final codex **CLEAN**. **LIVE-PROVEN end-to-end against REAL agent-ci** (WSL+Docker, real container
> runs): pass→**COMMIT** (`agent_ci_green:true`), job-fail→**RETRY** (+reason), infra-fail→**throw→escalate** (proven for real
> on native Windows where agent-ci can't run). **The live-prove earned its keep:** the NDJSON parser was first keyed off a
> GUESSED `type` field; the real `@redwoodjs/agent-ci@0.16.2` stream keys events by **`event`** (`{"event":"run.finish",
> "status":"passed"|"failed"}`) — keyed on `type`, EVERY real run (pass or fail) would parse as infra→throw→escalate: green
> unit tests, 100% useless in production. Fixed + locked with verbatim real-NDJSON tests. **GOTCHAS 55→57** (new:
> `[gate/agent-ci-not-runnable-on-native-windows]` — agent-ci dies pre-Docker on `tar C:\` so the feature is Linux/WSL-only
> in practice, Windows always infra-escalates; `[gate/agent-ci-ndjson-keyed-by-event-not-type]` — the guessed-shape trap).
> **PR #69 MERGED** (merge-commit `d5d5808`). **Then the operator battle-tested it and redirected (not polish yet):** v1 was
> config-file-only + buffered + unusable on his native-Windows harness (agent-ci is Linux/WSL-only). He wants agent-ci
> **observable IN the harness UI** and **runnable from his Windows box via WSL** — as a real product (Windows/Mac/Linux,
> later Tauri/Electron). Brainstormed it to a design: **`docs/superpowers/specs/2026-07-10-agent-ci-observability-design.md`**
> (cross-platform WSL-proxy invocation + honest capability reporting; streaming refactor of `agent-ci.ts`; hybrid transport
> = persist `agent-ci-events.ndjson` + SSE; a `CI` block in the Session inspector + a dedicated live step-tree CI screen,
> shadcn-first). **NEXT (s38): operator REVIEWS the observability spec → then writing-plans → subagent-driven build** (mode
> as always: Sonnet workers + mandatory codex gate + live-prove THROUGH the daemon+browser this time, not a standalone
> script). Polish track (per-field help → i18n → drift) is deferred behind this.
>
> ## ✅ MERGED (s36) — component-currency **Tier 2** (all 8 items) + native shell + desktop responsiveness → **PR #65 (`a5efbb5`)**; + 2 polish fixes → **PR #66 (`2bab3c7`)**
> Executed the full Tier 2 audit subagent-driven (Sonnet workers + codex GPT-5.5 gate per item), one PR. Operator added
> **desktop responsiveness** (no mobile) up front. **8 items, all codex CLEAN/CLEAN-after-fix:** toggle-group · **sidebar
> block + responsiveness** (icon-collapse <1280 via controlled `SidebarProvider`+matchMedia, Ctrl/⌘B; session rail
> auto-hides <1120 to a floating overlay; project rows→`SidebarMenu`, mount-gated fetch preserved) · **native inset
> refine** (operator UI feedback: `variant="inset"` = sidebar+content as SEPARATE panels; footer→native `DropdownMenu`
> NavUser pattern; daemon status→`Badge`) · chips→Badge/Button · checkbox · alert-dialog · collapsible · input-group.
> **Gate:** ui typecheck+build green every commit, codex CLEAN each module, CI 4/4, browser live-proof (3-region shell
> light+dark, Ctrl+B collapse, inset card, native footer + theme keep-open, composer focus). NOT live-clicked (logic+codex
> verified): rail-hide <1120 (window clamps ~1295px) + alert-dialog confirm (no escalation to reach). **Polish PR #66:**
> removed redundant `SidebarRail`; fixed collapsed-footer gear (**gotcha 54: tailwind-merge doesn't dedupe important +
> arbitrary-variant → base `p-2` beat lg's `p-0` → size-8 square clipped**; fix = bare `size-4` gear, native pattern, no
> crutch; operator-approved trade-off). GOTCHAS 53→55.
> **NEXT (s37): agent-ci gate hardening** (operator's call) — implement the s33 spec
> `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md`: an optional, config-gated, ADDITIONAL machine-gate
> step that replays the project's real GitHub Actions CI locally (`redwoodjs/agent-ci`) in the per-task worktree before
> commit; off by default, workflow-failure→RETRY, infra-failure→ESCALATE, never mandatory, never replaces the critic.
> Touches `src/gate/gate.ts` (most sensitive module) → TDD + codex gate. **Polish track is LOWER priority** (per-field
> help → i18n → drift check; + optional footer accent-tile via a real p-0 fix, backlog option B). No open blockers.
>
> ## ✅ MERGED (s35) — component-currency migration **Tier 1**, LIVE-PROVEN, **PR #63 merged to main** (`de57d6c`)
> Operator ask from s34 (prompted by the s34 `MessageScroller` miss): review EVERY UI component vs the current shadcn
> catalog (now via the LIVE shadcn MCP) and adopt purpose-built primitives. **Key reframe (gotcha 53):** our style is
> `base-nova` (shadcn on **Base UI**); the MCP's default-style metadata reports Radix deps, but the raw `base-nova`
> registry JSON shows the **whole catalog is Base-UI-ported** — so there's NO radix-foundation trap; the real filter is
> value/churn/behaviour. Audit written to `docs/wiki/component-currency-audit-s35.md` (Tier 1/2/3), driven by 3 parallel
> Explore agents. **Tier 1 shipped (5 module commits):** vendored 6 base-nova primitives (spinner/empty/kbd/label/field/
> bubble); rebuilt `Feedback.tsx` on shadcn `spinner`+`empty` (public signatures unchanged → every caller inherits);
> SessionRail `Loader2`→`Spinner`; RuntimeFileView/EscalationCard panel-empties→`EmptyState` (small inline one-liners
> deliberately kept as idiomatic text — `empty` is heavier than the idiom there); ChatModal `ChatBubble`→shadcn `bubble`
> (operator=default, assistant=outline; unused `message` primitive dropped); NewRunComposer ⌘⏎→`kbd`; RegisterForm 4
> fields→`field`; SettingsPopover `h-px`→`separator`. **Gate: root+ui typecheck+build ✓ · codex GPT-5.5 full-diff CLEAN
> (0 findings) ✓ · browser live-proof ✓ (real daemon+Chrome: `bubble` both variants in a real end-to-end chat, `kbd`,
> `spinner` pixel-proven; `Tabs`/`VerdictSeal`/`DiffView` intact, zero layout breakage) · CI 4/4 ✓.** GOTCHAS 52→53.
> **NEXT: Tier 2, item-by-item, subagent-driven (Sonnet 5 + codex critic)** — `toggle-group` (theme segments), `checkbox`
> (RegisterForm), `input-group` (composer shell), `collapsible`/`accordion`, `alert-dialog`, then the big `sidebar` block
> last; plus Badge/Button chip consolidation + vendored-primitive drift spot-check (`shadcn diff`). See `next-session-promt.md`.
>
> ## ✅ MERGED (s34) — orchestrator pre-launch chat, backend + UI, LIVE-PROVEN twice, **PR #62 merged to main** (`5989c26`)
> The full s33 orchestrator-chat plan (12 tasks) shipped: submitting an intent now opens a live multi-turn `claude -p`
> chat (`ChatModal`) — stream token-by-token, see a proposed-plan preview, Confirm & Launch fires the unchanged
> `handleIntent` path (adr/003 R1-safe). Subagent-driven (Sonnet workers + codex GPT-5.5 gate per module). **Full-diff
> codex gate ran 9 rounds — each found a real session/process-lifecycle edge case, all fixed with regression tests;
> final round CLEAN.** 913 tests / 3 skip, root+ui typecheck+build green, **CI green 4/4** (ubuntu+windows × node 20/22).
> LIVE-PROVEN via curl AND a real Chrome browser (real commit `a794b88` landed on aurora through the chat→confirm→
> launch→CLEAN flow). Operator-driven late improvement: swapped the chat transcript's generic `ScrollArea` for shadcn's
> purpose-built `MessageScroller` (`9f4d1d0`, auto-follows streaming). New: gotcha `[chat/onToken-bound-once]` (count 51);
> project `.mcp.json` wiring the **shadcn MCP** (live next session); **two backlog items** — set up/use the shadcn MCP +
> a component-currency audit of all UI components vs the current shadcn catalog. **No open items on this feature.**
>
> ## 🟢 s34 (detail) — orchestrator-chat COMPLETE, backend + UI, LIVE-PROVEN end-to-end (curl AND real browser)
> Executed the s33 orchestrator-chat plan in full (Tasks 1-12), subagent-driven (Sonnet 5 workers + mandatory codex
> GPT-5.5 critic gate per task, many real fix rounds — codex found and fixed a genuine bug in nearly every task:
> stderr-pipe hang, SIGKILL timer leak, oversized-line silent hang, isError swallowed, cancel-before-launch-success
> data loss, dead-SSE-socket writes, a throwing-sink `attachStream`/`release` gap, and — the standout finding — live
> token streaming silently never worked past the opening chat turn, since `ClaudeChatProcess`'s `onToken` is bound
> ONCE for a session's whole lifetime; new gotcha `[chat/onToken-bound-once]`, count 51). Backend: shared JSON-array
> extractor, chat wire-parser, `ClaudeChatProcess` (live multi-turn child), `ClaudeOrchestratorChatAdapter`
> (`--safe-mode`+`--strict-mcp-config`+`--tools ""` isolated), `ChatSessionManager` (registry/idle reaper/one-per-
> project guard/SSE detach — 5+ codex rounds), 5 HTTP routes (start/stream/message/confirm/cancel) with a clean
> `launchOrchestrate` extraction, composition-root + real-`ProjectView` wiring. UI: `api.ts`/`queries.ts` chat client
> mirroring `postOrchestrate`'s idiom, `ChatModal` (shadcn Dialog/ScrollArea/Badge composition) replacing the direct
> textarea-launch, `NewRunComposer` wired to open it (digest-watch toast arming preserved via `onLaunched`).
> **LIVE-PROVEN TWICE:** (1) curl end-to-end on aurora — real `claude -p opus` chat spawn, live SSE token frames
> matching the final reply, conversational continuity, `--safe-mode` confirmed in the real spawn args, clean cancel
> teardown (no orphan), confirm → real orchestrate → decompose → worker → critic correctly escalated a chat-guessed
> wrong assumption (no `PROVIDERS` map exists) rather than fabricating a commit. (2) **Real Chrome browser** (Task
> 12) — typed an intent, opened `ChatModal`, watched the real opening reply + proposed-plan preview render, sent two
> follow-up turns (conversational continuity confirmed via DOM), clicked Confirm & Launch → the dashboard showed
> `RUNNING` → `CLEAN` live, and a **real commit landed on aurora** (`a794b88`, `1 task · committed & merged`);
> separately verified Cancel enqueues nothing and releases the session slot (a fresh chat 200s instead of 409ing).
> **One UX polish item found** (not a functional bug): the chat transcript `ScrollArea` doesn't auto-scroll to the
> newest message — deferred to `FUTURE-BACKLOG.md`, not blocking. **Session-wide gotcha:** memory pressure on this
> box caused repeated transient `Fatal process out of memory`/`spawn UNKNOWN` errors from stale MCP-server/dev-server
> processes accumulated across PRIOR sessions (weeks old) — operator-approved cleanup freed the codex reviewer to
> run reliably; `curl -N` and the inline-diff-with-no-tools-preamble `codex task` recipe (not `codex review`) were
> the reliable workarounds when the sandboxed `git diff` kept failing. **Full-diff codex gate ran 7 rounds** — each
> found a genuine session/process-lifecycle edge case (stale-session confirm, shutdown-race leak, close-during-start
> resurrection, confirm-during-active-turn, unbounded opening-turn hang → permanent slot lock, then a self-inflicted
> timer leak in that very fix) — all fixed with regression tests. **Post-plan operator-driven improvement:** operator
> caught that the chat transcript used a generic `ScrollArea` where shadcn's purpose-built `MessageScroller` existed
> (a real methodology miss — worked from the locally-vendored shadcn set, not the live catalog). Swapped to
> `MessageScroller` (commit `9f4d1d0`, browser-verified: auto-scrolls to newest on every turn — closes the backlogged
> auto-scroll gap). Wired the **shadcn MCP into a new project `.mcp.json`** (project-level per operator, live next
> session) + backlogged a **component-currency audit** of all UI components against the current shadcn catalog.
> **Next: final confirming codex round on the timer-leak + MessageScroller diff, then `finishing-a-development-branch`
> (merge decision).**
>
> ## 📝 DOCS-ONLY (s33) — two specs written, no code yet: orchestrator-chat (+plan) and agent-ci gate-hardening
> Both s33 agenda items were discussion-first per the operator's ask; zero production diffs this session — four
> docs commits (`fa96605` chat spec, `294a78c` chat plan, `b330656` agent-ci recon, `72a09d8` agent-ci gate spec).
> **Next session starts by picking an execution mode for the chat plan** (subagent-driven recommended) OR by writing
> the agent-ci gate-hardening plan first — operator's call. Full detail: `docs/SESSION-LOG.md` s33 entry.

> ## ✅ DONE + MERGED (s32) — agency-agents pivot resolved + THREE backlog features (PRs #55/#56) + LIVE-PROVEN
> **Pivot first:** studied `github.com/msitarzewski/agency-agents` (MIT) vs the operator's 5-way frame → **#4 Not for us**
> (a ~280-file persona-prompt library + multi-tool installer, NOT an orchestrator; it *installs* prompt files, doesn't
> *run* agents — a layer above us; not redundant). Wrote `docs/wiki/agency-agents-analysis.md` + a **worker-persona-catalog**
> FUTURE-BACKLOG item (the wordpress/drupal personas map onto the woodev stack). **Then built the first three backlog
> items, each TDD + codex-GPT-5.5-gated to CLEAN, merged (PR #55 backend `f26e86a`, PR #56 UI `794ed2d`, CI 4/4):**
> 1. **onboarding-exclude** (`0c8a3de`): `ensureGitExclude` writes `.autodev/`+`.serena/` (per-entry idempotent) + a
>    best-effort **dirty-tree preflight** WARN at conductor `run()` start (skip-worktree hint for TRACKED churn files).
>    codex 2 findings → CLEAN.
> 2. **relaunch dedup / backlog C** (`61ad0cb`): `handleIntent` guard — `isDuplicateTask` (file_set overlap via
>    `fileSetsDisjoint` AND normalized-title match) vs pending/active/escalated. Full dup → enqueue nothing + re-trigger
>    the pool; partial → enqueue all + WARN (dependency-safe, fail-open). codex CLEAN 0 findings. **Backlog C CLOSED.**
> 3. **apply-on-accept** (`d0f9551` backend + `df149ca` UI): new reply **choice "C"** (operator gate-override, A/B
>    unchanged) replays `runtime/<id>/diff.patch` onto the loop branch → commit → done+markDone. Fails CLOSED: patch
>    validated (`git apply --numstat`) to touch only file_set (strict allowlist: `.env`≠`env`; abs/`..` rejected); branch
>    pinned to the captured loop-branch; clean-tree required; post-apply failure restores clean; LOUD override commit msg.
>    UI: "Commit anyway" button + confirmation modal (409 reason shown in-modal). codex 2 Sev-1+Sev-2+Sev-3 → +2 more
>    (leading-dot bypass, rollback exit codes) → **re-critic CLEAN**.
> **830 tests / 3 skip**, root+ui typecheck+build green. **LIVE-PROVEN overnight on `woodev-shipping-plugin-test` (real
> daemon):** #3 choice C committed a real diff → HEAD `c62a5f4` with the override marker, task escalated→done (+
> fail-closed: no-diff task → 409, stays escalated, no reply); #1 exclude on a fresh serena repo → `.serena/` excluded,
> tree stays clean; #1 preflight WARN fired on a dirtied tree. NB: existing pre-s32 projects don't retroactively get
> `.serena/` excluded (startup re-apply was scoped out) — one-time `git update-index --skip-worktree` still needed (the
> preflight hints it).
>
> ## ✅ DONE + MERGED (s32 cont'd) — live-proving #2 FOUND a real gap in the task-level dedup heuristic → fixed (PR #58)
> Operator resumed for the deferred #2 live-prove. **The live run found a real bug the unit tests could not:** the
> shipped `isDuplicateTask` (file_set overlap AND normalized-title match) requires the SAME title, but the LLM
> (opus decompose) re-titles the same relaunched work every time — same `file_set`, different `title` → no match →
> **fail-open → the relaunch enqueued a duplicate** (`dedup-proof-md` then `dedup-proof-doc`, same file, different
> title). Root-caused from `conductor.log` + the escalation queue; a compounding factor was the operator replying "A"
> to the first escalation mid-demo, moving it to `quarantine` (excluded from dedup by design) before the second
> launch — so the FIRST demo was doubly inconclusive, not just an accident.
> **Fix (operator-chosen, "intent-level dedup"):** compare the OPERATOR's intent text (normalized), not the LLM's
> retitled output. New `caps.read.recentRuns()` (bounded: `run-*.json` filter → sort → slice 50 BEFORE any read;
> per-candidate lstat + 64KB cap before parse — codex Sev-2 fixed). `handleIntent` now checks, BEFORE the expensive
> decompose: if this exact intent was already orchestrated and that run's tasks are still pending/active/escalated →
> skip decompose entirely, enqueue nothing, re-trigger the pool, WARN. Task-level heuristic kept as a secondary layer.
> codex gate: Sev-2 (unbounded manifest read) + Sev-3 (forged manifest, trusted stateDir) → bounded → **re-critic
> CLEAN**. **837 tests / 3 skip**, root+ui typecheck green. Merged PR #58 (`ec9721f`).
> **RE-LIVE-PROVEN clean**: two real orchestrate launches of the identical intent → run 2's log shows `"this intent
> was already orchestrated ... nothing enqueued -- re-triggering"` in **~30ms** (decompose skipped) → exactly ONE
> escalated task, zero duplicates. **All three backlog items are now live-proven end-to-end.** Demo artifacts cleaned;
> test repo left clean on `autodev/main`. **Lesson banked:** a live run found what 6 passing integration tests (built
> with controlled identical titles) could not — proportional live-proving on a gate-adjacent feature paid for itself.
>
> ## ✅ DONE + MERGED (s32 cont'd) — orchestrate was "silently" fire-and-forget → toast fix (PR #60) + a chat-orchestrator vision parked
> Operator pushback: after the dedup fix, HOW would the operator have known the run was deduped, vs a real silent
> failure? Root cause confirmed in code: `POST /orchestrate` returns 202 immediately (fire-and-forget by design,
> R1-safe); the actual outcome (enqueued / relaunch-dedup skip / 0-task / validation-rejected) is decided in the
> background and reported ONLY as a `[orchestrator] [LEVEL]` line in `digest.md`. `NewRunComposer` showed a static
> "Run accepted — decomposing intent…" that never updated, and `DigestStrip` (the activity log) only exists on
> `RunView`, not `Home` — and a dedup-skip records NO new run, so there's nowhere to click into. Confirmed genuinely
> silent, not operator mis-perception.
> **Fix (PR #60, `c58ad21`):** watch the already-WS-live `digestTail` (any digest.md write already triggers a WS
> "change" → query invalidation → refetch — no new backend) for the FIRST new `[orchestrator]`-line after a launch,
> within a 20s window, and toast it (sonner) with a level-mapped variant. Also fixed a latent scaffold bug: `sonner.tsx`
> read `useTheme` from `next-themes` (never mounted anywhere in this app) instead of the project's real `@/lib/theme`
> hook — toast theme would never have tracked the operator's actual light/dark choice; and mounted `<Toaster/>` at the
> app root (the primitive existed but was never rendered). codex: 1 real bug (toasting the LATEST orchestrator line
> instead of the FIRST new one after the launch's baseline) → fixed → re-critic CLEAN. Review-only UI (no test infra
> for this UI — established convention); ui typecheck+build green. **LIVE-PROVEN** end-to-end via the real data path
> (not synthetic): the actual `digest.md` WARN line from the earlier dedup live-prove, served by a real `GET /state`,
> parsed correctly by the exact shipped regex → `{level:"WARN", message:"..."}` → would call `toast.warning(...)`
> (the DOM render itself is out of API-reach, but every upstream stage is proven with real data).
> **Bigger picture, deliberately parked:** the operator's actual vision is a REAL CONVERSATION with the orchestrator on
> launch (not a fire-and-forget toast) — "we discussed this since early design." Toast closes today's narrower silent-
> no-op gap; the chat redesign is DEFERRED to its own brainstorm → spec → plan session (see `FUTURE-BACKLOG.md`
> "Orchestrator CHAT" — flags the `adr/003` gate-determinism tension as the key open question up front). **Next
> session opens there** (see `next-session-promt.md`), PLUS a new pivot recon the operator wants scoped: is
> `github.com/redwoodjs/agent-ci` (+ `agent-ci.dev/blog/the-agentic-dev-loop`) a nice-to-have, a YAGNI, or (operator's
> lean) a must-have for our loop — same recon-first discipline as the agency-agents pivot, before any building.
>
> ## ✅ DONE + MERGED (s31) — three stuck-task / runs-UI bug fixes + harness PROVEN end-to-end (green DONE)
> Started as a debug of a live SMOKE run "stuck in ACTIVE ~30 min" (no escalation/quarantine). Root-caused + fixed
> **three independent bugs**, all TDD + codex-GPT-5.5-gated + live-proven, merged as **PR #54 (merge-commit `3a0c641`,
> CI 4/4 green)**. **798 tests / 3 skip**, root+ui typecheck green.
> 1. **`ec8394c` merge-orphan (stuck-in-ACTIVE):** a gate-approved COMMIT whose worktree merge-back was refused (dirty
>    main tree / failed checkout) hung forever — `worktree.mergeAfterGate` THREW on those preconditions instead of
>    returning `{ok:false}`, bypassing the conductor's graceful `if(!mr.ok)` escalation → orphaned in `active/`, silently
>    locking its `file_set`. Fix: `mergeAfterGate` returns `{ok:false,reason}`; conductor escalates with the accurate
>    cause (conflict vs precondition); **defense-in-depth backstop** — a `catch` in `runIteration` fails ANY unhandled
>    throw closed to `escalated/` (never orphan; resolve-not-reject). Post-commit bookkeeping made best-effort. codex
>    CHANGES-REQUIRED (Sev-1 backstop-after-done) → re-critic CLEAN. Live-proven: same task now escalates `blocked`.
> 2. **`9e3157d` drain (stuck-in-PENDING = backlog B):** orchestrate enqueues to the GLOBAL pool but triggered a run
>    sized to its OWN batch (`maxIterations=specs.length`); the scheduler claims globally, so a pre-existing pending task
>    ate the batch's iterations and the batch's own task stranded with nothing to re-trigger it. Fix: `drain` run mode —
>    process until the queue is idle OR rate-limited, so one trigger clears the whole pool. codex CHANGES-REQUIRED
>    (rate-limit hang) → re-critic CLEAN. Live-proven: 2 pending tasks BOTH drained. **Backlog B is now CLOSED.**
> 3. **`a1c81d2` runs-id-dot ("No runs yet"):** run ids keep `.` from the intent slug (`slugifyIntent`/`isPathSafeId`
>    allow it) but the READ side (`isRunManifest` + `/runs/:id[/usage]`+PATCH) validated with the stricter dot-free
>    `safeIdSegment` → every filename-derived run dropped → HomeView "No runs yet". Fix: reuse `isPathSafeId` as the
>    read validator (`safeRunId`); task/escalation ids stay strict. codex CLEAN. Live-verified: `/runs` returns 8 (was 0).
> **HARNESS PROVEN END-TO-END (first real green DONE):** the operator pushed hard on "0 in DONE, everything escalates."
> Root cause was NOT a harness bug but three blockers stacked: (a) the test repo's main tree was perma-dirty (42 files);
> (b) **`.serena/project.yml` is TRACKED and Serena auto-rewrites it → re-dirties the tree mid-run** → `mergeAfterGate`
> refuses (new gotcha `[env/serena-churn-blocks-merge]`); (c) my "proof/smoke"-shaped test intents tripped the critic's
> fabricated-proof heuristic (correct gate behavior). After cleaning the tree (`reset --hard`+`clean`, removed a Windows
> `nul` via `\\?\`, `--skip-worktree` on `.serena`) + a LEGITIMATE intent → **worker → critic clean → gate COMMIT →
> merge → DONE**, real commit `a7b9f7b` on `autodev/main`. New gotchas (2): `[env/serena-churn-blocks-merge]`,
> `[api/run-id-dot-validation-mismatch]` (count 44→46). **Operator ask captured:** onboarding should git-exclude
> `.serena/`+`.autodev/` by default (FUTURE-BACKLOG). Still open: (C) no-dedup of a relaunched equivalent intent;
> apply-on-accept for escalations (s30). **NEXT SESSION IS A PIVOT — not the autodev plan:** study the "competitor"
> repo `github.com/msitarzewski/agency-agents` against a 5-way frame (redundant / adopt-alongside / new reference /
> not-for-us / other). See `next-session-promt.md`.
>
> ## ✅ DONE + MERGED (s30) — onboarding redesign (any-folder + auto git-init/branch + git-not-installed guard) — PR #53, CI green, live-proven
> Operator-designed (brainstorm→spec→plan→subagent-driven build, Sonnet workers + codex GPT-5.5 gate). Replaces the
> git-only New Project flow. **Spec** `docs/superpowers/specs/2026-07-07-onboarding-redesign-design.md`; **plan**
> `docs/superpowers/plans/2026-07-07-onboarding-redesign.md`. Native OS folder dialog was REJECTED for now (browser
> can't get a native path; daemon-spawned GUI is fragile on Windows + still needs the in-browser fallback) → deferred
> to the desktop wrap. Three features: (1) folder browser now selects ANY folder + hides system/hidden dirs; (2) inline
> **init git** for non-git folders (`git init` → empty commit → `autodev/main`; existing files stay UNTRACKED); (3)
> git-not-installed banner + "Install it now". **The s30 Task 1 branch-guard fix is delivered here** as the shared
> `ensureAutodevBranch` (`src/util/ensure-branch.ts`) — called on register AND defensively at daemon startup over every
> registered project (fixes pre-existing projects like `woodev-shipping-plugin-test` on `master`). Branch
> `autodev/s30-onboarding-redesign` (11 tasks, 790 tests / 3 skip, root+ui typecheck+build green). **codex gate:**
> CHANGES-REQUIRED (3 Medium + 2 Low) → fixed (`register` surfaces `branch_ensure_failed` instead of swallowing;
> `initGit` rejects paths INSIDE a work tree; 2 test fixes) → **re-critic CLEAN**. **Backend LIVE-PROVEN via curl**
> (`/system/git` git 2.49; git-init non-git→autodev/main+2 untracked+empty commit; 409 on re-init & on subdir-inside-worktree;
> hidden-dir filter; register; **startup ensure switched a project main→autodev/main, not recreated**). **MERGED via PR #53**
> (merge-commit, NOT squash — it also carried the whole s29 shadcn migration, which had only been merged LOCALLY in s29
> and rode this PR per the s29 handoff). **CI green 4/4** (ubuntu+windows × node 20/22). main tip = `f51d5d9`.
> **Operator LIVE-RAN a real orchestrate** on `woodev-shipping-plugin-test`: pipeline launched cleanly off `autodev/main`
> (branch fix CONFIRMED end-to-end), worker wrote the file, but the codex critic returned `broken` (0.62) because the
> SMOKE INTENT TEXT contained a non-ASCII em-dash — correct gate behavior, not a code bug. Operator hit A(accept) → task
> went to **quarantine (NOT committed)**: accept has no apply-on-commit machinery (s26 `[escalate/replied-holds-filelock]`),
> so an escalated smoke never lands a commit. A clean ASCII-only intent would commit. → new FUTURE-BACKLOG item "apply-on-accept".
> **Still open (operator-flagged in s29, OUT of scope this batch):** (B) orphaned PENDING tasks (enqueue-before-guard;
> make enqueue+trigger transactional / roll back on preflight fail) and (C) no dedup of a relaunched equivalent intent.
> Also: 3 corrupt run-manifest json files spam `WARN skipping unreadable/invalid run manifest` in daemon.log (harmless, cleanable).
>
> ## ✅ DONE (s29) — shadcn (Base UI) UI migration — COMPLETE (merged to main), UI live-verified by operator
> Operator wants the whole `ui/` moved to the **default shadcn look on Base UI (zinc)**, screen by screen.
> Spec: `docs/superpowers/specs/2026-07-06-shadcn-ui-migration-design.md` · Plan (checkboxes = progress):
> `docs/superpowers/plans/2026-07-06-shadcn-ui-migration.md`. Governing rule: **shadcn-first** (see AGENTS.md).
> Mode: subagent-driven (Sonnet 5 workers) + mandatory codex GPT-5.5 critic per phase; merge to main after
> critic-clean + green build/typecheck (operator away, autonomy granted). **Live browser-verify DEFERRED to
> operator** (browser tools were down this session) — nothing visually confirmed in a real browser yet.
> - **PR0 Foundation — ✅ MERGED to main** (`--no-ff`): shadcn init (Base UI/zinc/css-vars), reconciled theme
>   (IBM Plex + literal status vocab + legacy-token alias layer), `.dark` convention, 17 primitives, signature-
>   preserving Button/Card/TabBar/StatusPill/Dot/Feedback. Critic found+fixed 1 high (muted/accent token-alias
>   collision) + 1 medium (TabBar accent underline); re-critic clean. Build+typecheck green.
> - **PR1 App shell + navigation — ✅ MERGED** (`fcacece..65744f2`): AppShell/Sidebar/ProjectTopBar/SessionRail on
>   canonical shadcn tokens; ProjectSwitcherMenu → shadcn DropdownMenu; chip→Badge; ScrollArea in rail. Critic: all PASS, 0 findings.
> - **PR2 Board — ✅ MERGED** (`3bbd382..d186369`): TaskCard/ProjectRow/BoardView on shadcn tokens + ScrollArea.
>   Critic caught 2 High + 3 Medium (light-mode `bg-card/40` layer collapse since zinc `--card`==`--background`==white;
>   `group-hover:text-white`=white-on-white; inline `var(--color-muted)` used as text — a regression from PR0's alias
>   removal; leftover `var(--color-line-strong)`; `toneVar.idle` off legacy var) → fixed → re-critic all PASS.
> - **⚠️ Recurring gotchas for remaining PRs:** (a) zinc light theme `--card`==`--background`==white → never rely on
>   `bg-card` alone over the page for a layer; (b) `text-white` hovers break in light mode → use `text-foreground`;
>   (c) PR0's global sed only fixed `text-muted` CLASS, so inline `var(--color-muted)`/`var(--color-accent)` in JS
>   `style=` may still lurk in unconverted screens (now resolve to shadcn bg tokens) — grep each PR's files for them.
> - **PR3 Run screen — ✅ MERGED** (`ac267cc..` + clamp): RunView/Inspector/EscalationCard/DigestStrip/DiffView on
>   shadcn tokens; VerdictSeal rebuilt as shadcn composition (Badge + Progress subparts tone-tinted + muted rows);
>   new `ui/textarea.tsx`; DiffView stays custom. Critic: 1 Medium (confidence clamp) fixed, rest PASS.
> - **PR4 Task detail — ✅ MERGED** (`f951113..` + rail fix): TaskDetailView/NewRunComposer on shadcn tokens; spec/stage
>   boxes → Card; model chips → Badge(render=Link). Critic: 1 Medium (dark `--sidebar`==`--card` rail → `bg-muted/40`) fixed, rest PASS.
> - **PR5 Settings + onboarding — ✅ MERGED** (9 files): all settings/onboarding on shadcn tokens; SettingsPopover
>   rebuilt on shadcn Popover with the gear as the REAL trigger (fixed a toggle regression the naive split caused,
>   also touched Sidebar); form controls → Input/Select/Button. Critic: all PASS, 0 blocking.
> - **Final cleanup — ✅ MERGED:** legacy-token alias layer fully retired; `styles.css` body/scrollbar refs → shadcn
>   vars; only `--color-working/uncertain/broken/clean` status vars stay literal.
> - **Verification:** all 5 screen PRs + foundation + cleanup merged to `main`; every phase codex-GPT-5.5-gated
>   (findings fixed + re-critic); **766 tests pass / 3 skip, root+ui typecheck + build green.**
> - **⚠️ ONE open item — NOT verified in a live browser** (browser tooling was down all session). Live per-screen
>   visual proof in light+dark is left for the operator: `cd ui && npm run dev` (needs the daemon on :4319 for data).
> - **Gotchas to fold into `docs/gotchas/` next session:** zinc light `--card`==`--background`==white AND dark
>   `--sidebar`==`--card` → layer distinction needs a border or `bg-muted`; `text-white` hovers break in light (use
>   `text-foreground`); PR0's `text-muted`→`text-muted-foreground` sed didn't touch inline `var(--color-muted)` (a
>   shadcn BG token) used as a text color — a source of two critic findings.
>
> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-06 (s28 — **Agent extensions LANDED (PR #51): worker ambient-extension isolation + always-on
> critic NO-TOOLS preamble + live visibility scan.** Web-UI item (4) was rescoped after an empirical investigation proved
> the spawned worker (`claude -p`) + critic (`codex exec`) already INHERIT the operator's FULL ambient extensions (global
> `~/.claude`/`~/.codex` + project `.claude`/`.mcp.json`/`AGENTS.md`) — so an "attach" UI is redundant; the real need is
> visibility + isolation. **M1a** (codex merge-clean): `isolation.worker.{cleanRoom,mcp,skills}` (OFF by default →
> byte-identical spawn) → `workerIsolationFlags` (cleanRoom→`--bare`, mcp→`--strict-mcp-config`, skills→`--disable-slash-commands`,
> semantics probe-validated) appended to worker args; always-on NO-TOOLS preamble in `buildCriticPrompt` (closes docs-vs-code
> gap for `[critic/codex]`); projection + write path. **M1b** (codex 1 Medium + 1 Low fixed → re-critic clean): `GET
> /projects/:id/agent-extensions` streams the real worker CLI, captures `system/init`, kills before any model turn (zero
> model cost); thin `onScanExtensions?` ProjectView capability; MAX_REMAINDER_BYTES cap + never-reject spawner. **M2**
> (review-only): Isolation toggles (Clean-room master greys MCP/Skills) + live-scan panel. **766 tests / 3 skip**,
> typecheck+build green. **LIVE-PROVEN** (Playwright+curl): scan returned live 9/46/78/11; PATCH cleanRoom=true → re-scan
> 0/14/33/3 (matches `--bare` probe). 2 new gotchas (`[agents/inherit-ambient-extensions]` 40, `[detect/isolation-flags-not-orthogonal]`
> 41). Prior: s27 — **TWO web-UI modules LANDED.** (A) **role-matrix editor** (PR #48 `b8ebce6`): Project
> Settings roles section rewritten from a flat list into a 4-card matrix (orchestrator/worker/critic/planner), the
> operator-chosen cards layout. Backend (codex-gated **clean**, 0 findings): `ProjectConfigView` now exposes `roles.planner`
> (optional — projected ONLY when explicitly set in raw config via new `loadConfigWithRaw`+`isPlannerExplicitlyConfigured`),
> `policy.heterogeneity` + server-computed `heterogeneityWarnings` (reuses the existing source of truth, respects `off`);
> `ScaffoldFormSchema` accepts `roles.planner.{adapter,model,effort}`. UI (review-only): cards reuse s26
> `SelectOrCustomRow`/`EditableList`; planner OPTIONAL with "+ Configure planner" (seeds claude/sonnet) + orchestrator
> fallback; heterogeneity warn badge on the critic card. **LIVE-PROVEN**: full planner round-trip (unset→Configure→Save→
> config.yaml→projection includes planner→read card), detection-backed dropdowns. New gotcha
> `[ui/heterogeneity-badge-forward-looking]` (39) — the badge can't fire today (assertKnownAdapters forces
> claude-worker/codex-critic = always different families), it's forward-looking. (B) **plan checklist in the SessionRail**
> (PR #49 `e485c36`, operator ask): the newest run's ordered `taskIds` render as a live todo checklist (status glyph +
> title + done/total badge) after "Now"; binds `useRuns`+`useTaskIndex`, no new backend, WS-live. **LIVE-PROVEN** on a
> seeded 4-task run (Plan 1/4, per-status glyphs). 737 tests, CI 4/4 both PRs. Backlog: parked operator asks — per-field
> help tooltips/modals (early) + i18n Russian UI (late). **s28 opener candidate = web-UI item (4) skills/plugins/MCP
> surface**, then (5) polish. **Prior: s26 —** **PATH-scan auto-detect of installed CLI agents LANDED (PR #47) — first slice of the
> web-UI pilot→product track.** Backend (codex-gated): pure `src/detect/detect-agents.ts` curated catalog (claude/codex
> supported w/ model+effort catalogs; gemini/aider/opencode/cursor-agent/qwen/**ollama**/**kilocode** display-only),
> PATHEXT-aware **executable** PATH probe (`isFile`+POSIX`X_OK`, not bare `existsSync` — catches `codex.cmd`, rejects a
> same-named dir), best-effort version probe; daemon-global `GET /agents/detect` (mirrors `/fs/dirs`). `runNative` gained
> opt-in `timeoutMs` (SIGTERM→SIGKILL escalation; default unset = existing callers unaffected). UI (review-only): Global
> Settings "Installed agents" panel (status pill + version + Rescan) + Project Settings adapter/model/effort **dropdowns**
> (Custom… escape hatch; effort hidden where absent; buildDiff untouched). codex gate 3 rounds (1 High probe-leak + 2
> Medium + 1 Low → fixed; re-critic flagged SIGTERM-ignorable → SIGKILL → **re-critic CLEAN**). 712 tests, **LIVE-PROVEN**
> (real serve: claude.EXE + codex.CMD supported w/ versions, ollama/kilocode/opencode/cursor/qwen detected, both UI
> surfaces browser-proven). New gotcha `[detect/executable-probe]` (38). Commits `c9418d2`(M1)+`0a2b7f4`(M2), branch
> `autodev/s26-agent-autodetect`. Prior s26 — **replied-escalation file-lock FIXED (s26 opener, variant 1; PR #46 `351aa54`).** `POST /escalations/:id/reply`
> now transitions the replied task out of `queue/escalated/` to release its scheduler file-lock (gotcha 37, found live s25):
> **B (rework) → `pending`**, **A (accept) → `quarantine`**. A goes to quarantine NOT `done` — a codex **High**: `done`
> would falsely satisfy a dependent's `depends_on` (`doneIds`) on work that was never committed (the gate escalated instead
> of committing; no apply-on-accept machinery), so quarantine releases the lock without claiming repo-completion (operator
> decision after the gate). ENOENT tolerated (drift-*/double-reply)→200; other move errors→500. codex gate 1 High + 1 Medium
> → fixed (A→quarantine + dependency-safety regression test) → **re-critic CLEAN**. 693 tests (+5), typecheck green (root+ui);
> regression suite runs the REAL repo + REAL scheduler over REAL HTTP; real serve wiring statically confirmed. Fix commit
> `d5738d4`, branch `autodev/s26-escalation-filelock`. gotcha 37 marked RESOLVED. Prior: s25 — **UI cross-run token view (this run/today/all-time) + strip cost from telemetry
> LANDED (PR #45, squash `c4fae71`).** First consumer of the s24 `GET /runs/:id/usage` endpoint: SessionRail Tokens
> block shows three token rows via one `useSessionUsage` hook (retires the s22 N×M client walk). Operator's "token
> count only, NO cost" cleanup stripped `total_cost_usd`/`cost` end-to-end (backward-compatible — legacy docs with the
> field still validate + count token-only). codex gate 1 Medium (persist-by-reference cost-leak at the write boundary)
> + 1 Low → fixed (token-only copies at write boundary) → re-critic CLEAN. New gotcha
> `[usage/type-strip-not-runtime-strip]` (36). 688 tests, live-smoke rendered this run 120 / today 120 / all-time 220.
> **LIVE-PROVEN post-merge**: operator-driven aurora run → codex `clean` 0.98 → COMMIT `9b373aa`, real 531.5k tokens,
> de-costed. **Bug found live** → gotcha `[escalate/replied-holds-filelock]` (37): a replied escalation never leaves
> `escalated/` and silently file-locks future same-file runs → **s26 opener (variant 1)** = reply-apply must move
> escalated→done/pending. **Operator steer: UI is a PILOT, not final** — polish web UI to product (PATH auto-detect,
> preset model/effort pickers, …) BEFORE desktop wrap; **desktop DEFERRED**. Prior: s24 — **TWO modules landed.** (1) **critic-verdict.json persistence + committed-task verdict
> seal (PR #43, squash `b9b87f9`).** Conductor writes a per-task `critic-verdict.json` at a task's DECISIVE point
> (clean-commit or parseable escalation, never an intermediate retry round → no stale artifact), best-effort; the UI
> Inspector Verdict tab reads it (404-tolerant) and renders the REAL verdict (confidence + notes) for a committed task,
> closing `[ui/verdict-not-persisted]`. codex gate 3 findings (stale-artifact fixed decisive-only; clock-determinism
> declined; throwing-logger test) → re-critic CLEAN. New gotcha `[conductor/per-round-overwrite-stale]` (35).
> (2) **server-side per-run usage aggregation `GET /runs/:id/usage` (PR #44, squash `8067022`).** Read-only endpoint sums
> each task's `token-usage.json` server-side (the clean path for a future cross-run "today" total); reuses the
> TOCTOU-hardened readers, no new security code. codex gate 3 findings (dup-id double-count fixed; Promise.all-throw +
> sum-order fixed; case-insensitive-fs path-alias residual declined w/ rationale) → 684 tests, live curl-proven. Prior: s23 —
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
| **P3 — Product phase (grafts + wrap)** | 🟡 **IN PROGRESS.** Design-gated with operator; decomposed into slices. **Slice 1 — deps-provisioning DONE (s15, PR #29).** **Slice 2 — multi-project M1–M2 DONE (s16, PR #30).** **M3 New Project backend DONE (s17, PR #31 `7c80a90`):** `/fs/dirs` + `POST`/`DELETE /projects` + `.autodev` scaffold, codex R1 broken→re-critic uncertain→**clean**. **M4 product shell UI DONE (s17, PR #32 `c121a05`):** projectId-in-router, multi-project sidebar, composer Home, session rail, New Project screen + gated `GET /projects/:id/config`; browser-live-proven E2E. **M4-7 settings + M5 light theme DONE (s18, PR #34 `75f9675`, review-only):** Global + project settings screens replace the placeholders; `[data-theme="light"]` token set completes the switcher; browser-proven both themes + real E2E unregister. **Backlog polish DONE (s19):** rename endpoint (PR #36), config-write endpoint + editable project settings (PR #37, codex found+fixed 2 blockers), composer project-switcher real menu (PR #38). 633 tests, CI green 4/4. **Backlog polish continued (s20):** Project Settings edit mode extended to every role field (PR #40, review-only). **woodev deps-provisioning ops-proof LANDED (s21):** real woodev clone provisioned (`vendor`+`plugins-reference` junctions) → harness `run --once` → real static gate `composer check:static` (phpcs+phpstan) GREEN in worktree → **COMMIT `912ef64`** → safe teardown. **P3 CLOSED end-to-end; no operator-gated items remain.** **Post-P3 — token/usage instrumentation LANDED (s22, PR #41 `675baf0`):** worker/critic adapters expose usage → conductor persists per-task `token-usage.json` (best-effort) → Tokens rail aggregates on the client; codex-gated (1 Medium fixed → re-critic clean), 654 tests, browser-smoke proven. **Run rename + archive + UI re-run LANDED (s23, PR #42 `53d2ced`):** `PATCH /runs/:id` (rename/soft-archive, manifest-index only) + `GET /runs?includeArchived` + RunView actions bar; codex-gated (3 defects fixed → re-critic clean), 662 tests, browser-smoke proven full flow. **critic-verdict.json persistence + committed-task verdict seal LANDED (s24, PR #43 `b9b87f9`):** conductor writes a per-task `critic-verdict.json` at the DECISIVE point (clean-commit / parseable escalation, never intermediate rounds), best-effort; UI Inspector Verdict tab reads it (404-tolerant) and shows the REAL verdict+confidence+notes for a committed task (closes `[ui/verdict-not-persisted]`); codex-gated (2 Medium + 1 Low, decisive-only fix + reasoned decline → re-critic CLEAN), 671 tests, browser-smoke proven. **Server-side per-run usage aggregation `GET /runs/:id/usage` LANDED (s24, PR #44 `8067022`):** read-only endpoint sums each task's `token-usage.json` server-side (clean path for a cross-run "today" total); reuses TOCTOU-hardened readers, no new security code; codex-gated (dup-id + Promise.all-throw + sum-order fixed, case-alias residual declined) → 684 tests, live curl-proven. **UI cross-run token view + strip-cost LANDED (s25, PR #45 `c4fae71`):** SessionRail Tokens = this run / today / all-time via one `useSessionUsage` hook over `GET /runs/:id/usage` (retires the s22 N×M client walk); operator's "token count only, NO cost" cleanup strips `total_cost_usd`/`cost` end-to-end, backward-compatible (legacy docs still validate + count token-only); codex-gated (1 Medium persist-by-reference cost-leak at the write boundary + 1 Low → fixed → re-critic CLEAN), new gotcha `[usage/type-strip-not-runtime-strip]` (36); 688 tests, live-smoke rendered this run 120 / today 120 / all-time 220. **Replied-escalation file-lock FIXED (s26, commit `d5738d4`):** `POST /escalations/:id/reply` moves the replied task out of `queue/escalated/` (B→`pending`, A→`quarantine`; A→quarantine not `done` per codex High — `done` would falsely satisfy a dependent's `depends_on` on uncommitted work) → releases the scheduler file-lock (gotcha 37 RESOLVED); codex-gated 1 High + 1 Medium → re-critic CLEAN, 693 tests. |

## Frozen skeleton (codex-verified — do not re-litigate without cause)

1. **State:** file-blackboard = truth (git-tracked), behind `BlackboardRepository` seam.
2. **Worker interface:** pluggable `WorkerAdapter`/`CriticAdapter`; MVP = `claude` + `codex`.
3. **Checkpoint:** conductor commits-to-branch **after** gate; `Checkpoint` seam → PR later.
4. **Isolation:** per-task `git worktree` (AO pattern), non-destructive teardown.
5. **Gate:** independent diff-critic + machine gate; **self-critique rejected**; `GateExtension` seam → action-level risk.
6. **Routing:** declarative per-task `model:` (no donor does complexity routing); `Router` seam → BYOK.

## Last session (s28, 2026-07-06)

**Agent extensions LANDED (PR #51) — worker ambient-extension isolation + always-on critic NO-TOOLS preamble + live
visibility scan. Web-UI item (4) was rescoped from "attach skills/plugins/MCP" to "visibility + isolation" after an
empirical investigation. 3 modules, both backend ones independently codex-gated.**

### The s28 opener — INVESTIGATION, not a build (operator's s27 steer)
- Explore recon + **two live `claude -p` probes** proved the spawned worker (`claude -p`) and critic (`codex exec`) child
  CLIs **INHERIT the operator's full ambient extension set** (global `~/.claude`/`~/.codex` + project config): env
  passthrough (`watchdog`/`native` use `env: process.env`, no HOME/CONFIG_DIR override), worker cwd = the git worktree
  (carries tracked `.claude`/`.mcp.json`/`AGENTS.md`), and `-p`/`exec` load MCP+skills+plugins+subagents+hooks at runtime
  (bare cwd → 9 MCP / 46 skills / 78 slash / 17 plugins / 11 agents + SessionStart hook). → gotcha
  `[agents/inherit-ambient-extensions]` (40).
- **Reported to operator → decided WITH him:** item (4) "attach" is redundant; build **visibility + isolation** instead.
  Operator picks: (1) isolation = configurable set + a Clean-room preset; (2) live visibility panel YES; (3) NO-TOOLS
  preamble always-on. A probe of the isolation flags (probe C) found they are NOT orthogonal → gotcha
  `[detect/isolation-flags-not-orthogonal]` (41): `--bare` IS clean-room (drops MCP+skills too), only
  `--strict-mcp-config`/`--disable-slash-commands` are clean levers; init `plugins` count lists installed-not-active.

### M1a — isolation mechanism (backend, codex merge-clean, commit `34c83f4`)
- `isolation.worker.{cleanRoom,mcp,skills}` (all default `false` → byte-identical current spawn). `workerIsolationFlags(cfg)`:
  cleanRoom→`["--bare"]` (subsumes the orthogonal flags), else `--strict-mcp-config` (mcp) / `--disable-slash-commands`
  (skills), appended to the worker `claude -p` args. **Always-on NO-TOOLS preamble** built into `buildCriticPrompt`
  (complementary to the existing fencing; closes the docs-vs-code gap — we relied on it manually, it was never in code).
  Projection (`ProjectConfigView.isolation`) + write path (`ScaffoldFormSchema`+`buildConfigYaml`+`mergeConfigYaml`) mirror
  the roles pattern. codex GPT-5.5 gate: merge-clean, 0 blockers (2 Low/UX notes → the M2 UI).

### M1b — visibility scan endpoint (backend, codex 1 Medium + 1 Low fixed → re-critic clean, commit `62307c7`)
- `GET /projects/:id/agent-extensions`: spawns the real worker CLI with the effective isolation flags, STREAMS stream-json
  stdout, captures the first `system/init`, KILLS the child before any model turn (zero model cost). Pure `extractExtensions`
  (defensive; echoes input cwd, never trusts init.cwd) behind an injectable `SpawnInit`; the default streaming spawner
  mirrors `util/native.ts` (SIGTERM→grace→SIGKILL, EPIPE guard, settled-once) + a partial-line remainder buffer. Thin
  `onScanExtensions?` ProjectView capability (mirrors `onOrchestrate?`; unset→404). codex: Medium (unbounded remainder →
  `MAX_REMAINDER_BYTES` cap + kill) + Low (spawner sync-throw → try/catch, honors never-reject; `spawnFn` injected for
  tests) FIXED; Low (endpoint-guard) DECLINED (consistent with `handleDetectAgents`; global `.catch` backstop; a local
  `{extensions:null}` would mask a bug) → re-critic accepted both + the decline.

### M2 — UI (review-only, commit `7b7e773`)
- Project Settings "Isolation" section: Clean-room master toggle + Strip-MCP + Strip-skills, wired into `buildDiff`
  send-only-changed; **Clean-room ON greys the MCP/Skills toggles** ("included in Clean-room" — closes the M1a Low UX
  note). "Agent extensions" section: Scan/Rescan button (s26 idiom) → renders the worker's inherited MCP (name+status
  pill) / skills / slash-commands / agents; honest not-scanned/loading/null/error states; a static critic note.

### Verification
- 766 tests / 3 skipped, root+ui typecheck clean, `build`+`build:ui` green, CI (PR #51). **LIVE-PROVEN** on a real serve
  (Playwright + curl): config projection carries isolation; scan returned the live ambient set (9/46/78/11); PATCH
  `cleanRoom=true` → re-scan **0/14/33/3** (matches the `--bare` probe table); UI rendered read/scan/edit states and the
  Clean-room greying. Screenshots to operator. Seed + daemon torn down; throwaway pngs deleted (not committed).

## Last session (s27, 2026-07-06)

**Two web-UI pilot→product modules landed: (A) the role-matrix editor (item 3, PR #48), then (B) the plan checklist in
the session rail (operator ask, PR #49). Both self-merged after codex-gate(where applicable)+green CI+live-proof.**

### (A) Role-matrix editor — web-UI item 3 (PR #48 `b8ebce6`)
- **Layout discussed WITH the operator first** (his zone): chose **cards** (not a grid), planner **optional** with
  orchestrator-fallback, and heterogeneity warning **surfaced honestly from the backend**.
- **Recon-first** (Explore subagent) mapped `src/config/roles.ts` (roles registry, `heterogeneityWarnings`,
  `adapterMeta`, `assertKnownAdapters`), the config projection (`ProjectConfigView` + `src/index.ts` populate + GET
  handler), `ScaffoldFormSchema`, and the existing `ProjectSettingsView` roles section + `SelectOrCustomRow` + `buildDiff`.
- **Backend (codex-gated `93928af`, Opus worker, TDD):** `ProjectConfigView` gains `roles.planner?` (projected ONLY when
  the operator explicitly set `roles.planner` in the RAW config — new `loadConfigWithRaw` returns `{cfg, raw}` with no
  second read; `isPlannerExplicitlyConfigured(raw)` gates it, since the parsed cfg always defaults planner),
  `policy.heterogeneity` (read-only) + `heterogeneityWarnings[]` (reuses `heterogeneityWarnings(cfg)` — respects `off`).
  `ScaffoldFormSchema` accepts `roles.planner.{adapter,model,effort}` (strict, mirrors orchestrator; wired through
  `buildConfigYaml`+`mergeConfigYaml`). Pure `buildProjectConfigView` extracted to `src/api/config-view.ts`. No runtime
  planner routing (reserved). **codex GPT-5.5 gate: merge-clean, 0 findings.**
- **UI (review-only `61c5d4c`, Opus worker):** roles section → 4 role cards; reuse s26 `SelectOrCustomRow`/`EditableList`.
  Planner OPTIONAL: read-unset→dimmed "not set · orchestrator handles planning"; edit-unset→"+ Configure planner" (seeds
  claude/sonnet, `addPlanner` intent flag gates `buildDiff` so planner never sent unless added); configured→editable.
  Heterogeneity warn badge on the critic card + verbatim strip (reuses `--color-uncertain` amber token). `buildDiff`
  send-only-changed contract preserved.
- **Verification:** 737 tests / 3 skip, typecheck clean (root+ui), CI 4/4. **LIVE-PROVEN** on a real serve: read/edit
  cards, detection-backed dropdowns (Claude Code/Codex CLI/GPT-5.5/effort), and the FULL planner round-trip
  (unset→Configure→Save→`roles.planner` in config.yaml→projection includes planner via the raw-presence gate→"claude ·
  sonnet" read card). Screenshots to operator. New gotcha `[ui/heterogeneity-badge-forward-looking]` (39): the badge
  can't fire today because `assertKnownAdapters` forces worker=claude/critic=codex (always different families) — it's
  deliberate forward-looking insurance, not dead code; data path proven by `config-view.test.ts`.

### (B) Plan checklist in the session rail (operator ask, PR #49 `e485c36`)
- Operator asked mid-session: after the plan is written, show the plan todo list in the right sidebar as a checklist.
- **Recon-first** (Explore) mapped `SessionRail.tsx` (Now/Queue/Session/Roles/Tokens `Block`s), the run→tasks
  association (`RunManifest.taskIds` is the ordered plan; no `run_id` on tasks), `useTaskIndex` join, and `QUEUE_META`/
  `StatusPill`/`Dot` primitives. **No new backend needed** — `useRuns`+`useTaskIndex` (over `/runs`+`/state`) fully supply
  ordered ids + live per-task status, both already WS-invalidated.
- **UI (review-only, Sonnet worker):** new `<Block title="Plan">` after "Now": newest run (`runs[0]`, same convention as
  `useSessionUsage`) → its `taskIds` as a checklist. Glyph map (reuse `QUEUE_META` tones): done→`Check` (clean),
  pending→`Square` (idle), active→pulsing working dot, escalated→uncertain dot, quarantine→broken dot, unresolved
  id→muted idle dot (mirrors RunView's fallback so length==plan). `done/total` progress badge; plan label; "no plan yet"
  empty state.
- **Verification:** typecheck clean (root+ui), build:ui green, CI 4/4. **LIVE-PROVEN** on a seeded run (4 tasks across
  done/active/pending/escalated) → rail rendered **Plan · 1/4** with the correct per-status glyphs. Screenshot to
  operator. Follow-up noted (not blocking): active & escalated both render amber-family dots (inherited Board palette).

### Backlog captured (operator asks, `e485c36` docs commit rode PR #48)
- **Per-field help — tooltips/option-description modals** (many settings options aren't self-explanatory even to the
  operator). Scheduled EARLY in the polish pass. - **i18n / Russian UI language** — scheduled near the END (cross-cutting
  string refactor). Both in `FUTURE-BACKLOG.md` "Web UI: pilot → product".

## Last session (s26, 2026-07-05)

**Two modules landed this session: (A) the s26 opener (escalation file-lock fix, PR #46), then (B) the first web-UI
pilot→product slice (agent auto-detect, PR #47).**

### (B) PATH-scan auto-detect of installed CLI agents (PR #47) — web-UI pilot→product slice 1
- **Recon-first** (general subagent) mapped Open Design's donor detection (`references/open-design`): hardcoded ~25-agent
  registry + pure `existsSync` PATHEXT-aware PATH walk (not `which`), `execFile` version probe, static `fallbackModels` +
  optional live probe, per-agent `reasoningOptions`, SSE streaming. Our reality: only 2 live adapters (claude/codex);
  `cross-spawn` already owns spawn-time PATHEXT so detection is a SEPARATE read-only probe; UI seam = `GET /fs/dirs`.
- **Operator UX steer**: Settings dropdowns (claude/codex) **+ a Global "Installed agents" panel** (all agents, unsupported
  greyed). Operator also asked to add **ollama + kilocode** to the catalog (display-only).
- **M1 backend (codex-gated, `c9418d2`)**: `src/detect/detect-agents.ts` — curated catalog, PATHEXT-aware executable probe
  (`isFile`+POSIX `X_OK`), best-effort version; `GET /agents/detect` daemon-global (via admin port). `runNative` opt-in
  `timeoutMs` (SIGTERM→SIGKILL). **codex 3 rounds**: High (probe timeout leaked the child → `runNative` kill deadline) +
  Medium (`existsSync` false-positives for dirs/non-exec → `isFile`+`X_OK`) + Medium (non-portable win32 test → `codex.CMD`)
  + Low (relative path → `resolve`) → fixed; re-critic caught SIGTERM-ignorable → SIGKILL escalation → **re-critic CLEAN**.
- **M2 UI (review-only, `0a2b7f4`)**: Global "Installed agents" panel (status pill/version/Rescan) + Project Settings
  adapter/model/effort dropdowns (`SelectOrCustomRow` with Custom… escape hatch; effort hidden for no-effort adapters;
  worker ladder unchanged; `buildDiff` untouched — both control modes write the same draft string).
- **Verification**: 712 tests, typecheck+build green (root+ui). **LIVE-PROVEN** on a real serve: `/agents/detect` returned
  claude (`claude.EXE` v2.1.201) + codex (`codex.CMD` v0.142.5 — PATHEXT shim resolved, NOT missed) supported; ollama
  (`ollama.EXE`), kilocode (`kilocode.CMD`), opencode, cursor-agent, qwen detected display-only; gemini/aider not-detected.
  Both UI surfaces browser-proven (screenshots to operator). New gotcha `[detect/executable-probe]` (38).

### (A) Replied-escalation file-lock fix (s26 opener, variant 1; PR #46 `351aa54`)
- **Replied-escalation file-lock FIXED — the s26 opener (operator-chosen variant 1), a real correctness/UX bug found live
  in s25** (`[escalate/replied-holds-filelock]`, gotcha 37). `POST /escalations/:id/reply` recorded a `*.reply.json` but
  left the task in `queue/escalated/`, whose `file_set` silently blocked every future same-file run (`claimNextTask` locks
  on `active`+`escalated` alike) — no operator signal.
- **Recon-first** (Explore subagent) mapped the reply handler ↔ escalate module ↔ scheduler lock ↔ the one transition
  helper `repo.moveTask`. Confirmed escalation id === task id; `escalated` was effectively terminal (nothing moved a task
  out of it anywhere).
- **Fix (TDD):** `handleReply` transitions the replied task out of `escalated/` after writing the reply — **B → `pending`**
  (re-queue/rework), **A → `quarantine`** (accept). ENOENT tolerated (drift-* has no queue file; double-reply)→200; other
  move errors→500 (surface a still-held lock).
- **codex GPT-5.5 gate — 1 High + 1 Medium → fixed → re-critic CLEAN.** High: the first cut used **A → `done`**, which
  falsely satisfies a dependent's `depends_on` (`doneIds`) on work never committed (no apply-on-accept machinery). **Operator
  decided A → `quarantine`** (releases the lock without claiming repo-completion; quarantine is neither in the lock set nor
  in `doneIds`). Medium: added a dependency-safety regression test. No new gotcha (gotcha 37 marked RESOLVED; +1 operational
  note to `[critic/codex]` — a background codex run can stall spawning its own plugins in the blocked sandbox, use a
  NO-TOOLS preamble + foreground).
- **Verification.** 693 tests (+5) / 2 skip, typecheck green (root+ui). Regression suite drives the REAL
  `FileBlackboardRepository` + REAL `createScheduler` over a REAL HTTP server; real serve wiring (`src/index.ts:150`)
  statically confirmed so `p.repo.moveTask` works at runtime. Proportional — no aurora live-run (integration test already
  exercises the HTTP→repo→scheduler path; no UI surface changed). Fix commit `d5738d4` on `autodev/s26-escalation-filelock`.

## Last session (s25, 2026-07-05)

- **UI cross-run token view + strip cost SHIPPED & MERGED (PR #45, squash `c4fae71`).** The recommended s24 opener —
  first consumer of the s24 `GET /runs/:id/usage` endpoint, plus the operator's "token count only, NO cost anywhere"
  cleanup (memory `[[feedback-usage-tokens-not-cost]]`). Backend codex-gated; UI review-only.
- **UI (review-only).** SessionRail Tokens block now shows **this run / today / all-time** via one `useSessionUsage`
  hook: fetch the runs list once, call `getRunUsage` per run, bucket in a SINGLE pass (`thisRun` = newest run, `today`
  = runs whose manifest `at` is in the local calendar day, `allTime` = every non-archived run). Retires the s22
  client-side N×M `useRunUsage` walk. New server `RunUsageSummary` type + `getRunUsage` client method in `api.ts`;
  `SessionUsage` shape in `queries.ts`.
- **Strip cost (backend, codex-gated — touches conductor artifact shape + endpoint).** Removed `total_cost_usd`/`cost`
  from `WorkerUsage`, `TokenUsageDoc` (nested + top-level), `parseClaudeUsage`, `buildTokenUsageDoc`, `RunUsageSummary`,
  `buildRunUsageSummary`, `isTokenUsageDoc`, and the UI mirrors. **Backward-compatible**: a legacy `token-usage.json`
  still carrying `total_cost_usd` validates + contributes its tokens (never its cost) — `isTokenUsageDoc` ignores the
  extra field (tolerant-in, strict-out).
- **codex GPT-5.5 gate — 1 Medium + 1 Low → fixed → re-critic CLEAN.** Medium: `buildTokenUsageDoc` persisted
  `worker.runs` by REFERENCE — deleting the field from the *type* doesn't strip it from a *runtime* object, and
  `JSON.stringify` serializes the real shape → a stray cost could leak into the written artifact. No active trigger
  (sole `WorkerUsage` constructor is cost-free) but cheap defense at a persisted-artifact write boundary; fixed by
  rebuilding worker+critic per-run arrays as token-only copies + a regression test asserting `JSON.stringify(doc)` has
  no `/cost/i`. New gotcha `[usage/type-strip-not-runtime-strip]` (count 35→36).
- **Verification.** 688 tests (+2 skipped), typecheck green (root+ui), both bundles rebuilt. **Live-smoke** on a seeded
  2-run project: endpoint curl-proved (`run-a` tokens=120 with no `cost` field; `run-b`=100; legacy-with-cost task
  counted token-only) → rail rendered this run 120 / today 120 / all-time 220 (older run excluded from today, included
  in all-time). Screenshot sent; seed + daemon torn down. Self-merged (machine bar + green CI 4/4).
- main tip = `c4fae71` (PR #45 squash — folded in the two unpushed s24 docs commits per batch-merges). This session-save
  docs commit rides the next PR. Working tree clean.
- **LIVE TOKEN-RUN DEMO on aurora (post-merge, operator-driven).** Served the daemon on aurora's real state; operator
  drove a fresh `orchestrate` from the UI. Live result: worker (sonnet) → `php -l` gate → **codex critic `clean` 0.98**
  → **COMMIT `9b373aa`**; `token-usage.json` written with real worker usage (**531,533 tokens**) and **no `cost` field**
  (s25 strip proven live); the rail rendered this run / today / all-time = 531.5k. Also exercised s24's persisted
  `critic-verdict.json` (real seal). Demo daemon + scratch registry torn down; aurora left on disposable branch
  `autodev/s25-token-demo` with commit `9b373aa`.
- **BUG FOUND LIVE → `[escalate/replied-holds-filelock]` (gotcha 37) + s26 opener.** The run initially would NOT start:
  decompose+enqueue succeeded but the task sat in pending, worker never ran, `conductor.log` silent. Root cause = a
  replied-but-uncleared escalation (`docs-llmfactory-classdoc-v2`, s14) held its `file_set` as a scheduler lock, and
  `claimNextTask` blocks any pending task whose `file_set` intersects an `escalated` task — so every same-file run was
  silently blocked with no operator signal. Unblocked by moving the resolved escalation → `done` (operator-approved).
  The reply-apply-clears-escalated fix is the **s26 opener (variant 1)**.
- **Operator UI/UX steer: the dashboard is a PILOT, not final.** Product-completeness (PATH auto-detect of installed
  CLIs, preset model/effort pickers, richer role matrix, skills/plugins/MCP surface) is unbuilt. **Polish the web UI to
  a real product BEFORE the desktop wrap; desktop DEFERRED.** Captured in `FUTURE-BACKLOG.md` "Web UI: pilot → product".

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
- **Module 2 — server-side per-run usage aggregation `GET /projects/:id/runs/:runId/usage` (PR #44 `8067022`, MERGED).**
  Operator picked NEXT-ACTIONS candidate (b). Read-only endpoint sums each task's `token-usage.json` server-side — the
  clean path for a future cross-run "today" total (s22 was client-side per-run only). Pure `buildRunUsageSummary` +
  `isTokenUsageDoc` in `src/usage/usage.ts`; `handleGetRunUsage` in `server.ts` REUSING `readBoundedManifest` +
  `readBoundedFileText` (no new file-reading security code). codex gate: Medium dup-id double-count → FIXED (dedupe + drop
  path-unsafe ids; `taskCount` = unique-safe); 2 Low (Promise.all-throw, sum-order) → FIXED (per-task try/catch → `T|null`
  → filter, manifest-order). Re-critic residual: case-insensitive-fs path-alias (`["t1","T1"]`) → DECLINED w/ rationale,
  documented in the handler. 684 tests (+13), live curl-proof (`tokens:5000 cost:0.08 taskCount:2`; unknown→404). No UI
  consumer yet (a "today" view is the follow-on) — endpoint is the deliverable per scope.
- **(c) codex `--json` — ASSESSED & DECLINED (operator agreed).** Reconned before building; found it risks the
  enforcement gate for marginal telemetry (see NEXT ACTIONS for the full rationale). Not built. Recommended cheap next
  instead: a UI "today" usage view over the new endpoint.
- **Both s24 PRs MERGED.** main tip = `8067022` (PR #44 squash, carries PR #43 `b9b87f9` beneath it). NOTE: the s24
  docs (this file + SESSION-LOG + the new gotcha) for module 1 rode into #44's squash; the module-2 + session-save docs
  sit on local main and ride the next PR (batch-merges). Working tree clean.
- **Workflow snag (self-inflicted, avoid next time):** made uncommitted docs edits on the #44 feature branch, then the
  post-merge `git reset --hard origin/main` DISCARDED them — had to re-apply. Lesson: commit docs (or make them on `main`
  after the merge-sync) BEFORE any `reset --hard`; never leave uncommitted work in a branch you're about to reset.

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

## NEXT ACTIONS (s29)

**s28 LANDED web-UI item (4), rescoped: Agent extensions — worker isolation + always-on critic NO-TOOLS preamble + live
visibility scan (PR #51, 3 modules, both backend ones codex-gated, live-proven).** The extensibility trio is NOW handled
honestly (agents already inherit ambient extensions; the UI shows + isolates them, not "attaches"). **The web-UI
pilot→product track items 1–4 are all DONE.** What remains is **(5) general polish**:
- **Per-field help — tooltips / option-description modals (do EARLY).** Many settings options aren't self-explanatory even
  to the operator; parked in `FUTURE-BACKLOG.md` "Web UI: pilot → product". Best cheap next pull-forward.
- **Heterogeneity-badge / status-glyph follow-up (cheap early polish).** s27 note: active & escalated both render amber —
  add distinct escalated/quarantine glyphs or a per-row status label (also applies to the s27 plan checklist).
- **i18n / Russian UI (do LATE).** Cross-cutting string refactor once copy stabilises.
- **Desktop wrap — DEFERRED** (Electron/Tauri; own IA/UX discussion, not until the web UI is a polished product).

**Possible s28 follow-ups (only if asked):** critic-side live scan (codex has no clean init JSON — would need a bespoke
probe); a New-Project registration-time isolation default; per-worktree scan cwd (today the scan runs in the project
repoRoot, not a task worktree — a committed `.mcp.json` in a feature branch wouldn't show until merged); reconcile the
scan's cheap `ladder[0]` model pick if a project pins an expensive first-ladder model (model is irrelevant to WHICH
extensions load, but the arg is passed).

## Prior NEXT ACTIONS (s27 — mostly closed)

**P3 is CLOSED; FIVE post-P3 modules LANDED — token/usage (s22, PR #41), run rename/archive+re-run (s23, PR #42),
critic-verdict.json persistence + committed-task verdict seal (s24, PR #43), server-side per-run usage aggregation
(s24, PR #44), and UI cross-run token view + strip-cost (s25, PR #45).** The product shell is complete (register →
scaffold → drive → settings → theme), the usage telemetry is now token-only end-to-end with a this-run/today/all-time
rail. **No operator-gated items remain.** Everything below is backlog polish or an optional stretch; pick with the
operator UNLESS granted autonomy.

**~~s26 OPENER (variant 1): fix the replied-escalation file-lock~~ — DONE (s26, commit `d5738d4`).** `POST
/escalations/:id/reply` now moves the replied task out of `queue/escalated/` (B→`pending`, A→`quarantine`; A→quarantine
not `done` per a codex High + operator decision — `done` would falsely satisfy a dependent's `depends_on` on uncommitted
work). codex-gated (1 High + 1 Medium → fixed → re-critic CLEAN), 693 tests, gotcha 37 RESOLVED. Possible follow-up
only if asked: surface a "this escalation is resolved/cleared" state in the UI (today the reply just records + releases
the lock; the RunView/board doesn't visibly distinguish a quarantined-by-accept task from a poisoned one).

**Web UI pilot → product track (operator steer, s25): the current dashboard is a PILOT, not final.** Finish
debugging + polishing the web UI to a real product BEFORE any desktop wrap. Build order + status:
(1) **~~PATH-scan auto-detect of installed CLI agents~~ — DONE (s26, PR #47).** Backend detector + `GET /agents/detect`
+ Global "Installed agents" panel; replaces hand-typed `adapter`/`exe` with a detected list. (2) **~~preset model +
effort pickers per adapter~~ — DONE (s26, PR #47).** Project Settings adapter/model/effort dropdowns from the detected
catalog (Custom… escape hatch). **s27 OPENER = (3) richer role-matrix editor** (the roles section is now dropdown-driven;
next is a cohesive matrix view over all four roles + heterogeneity/warn surfacing); then (4) **skills/plugins/MCP surface**;
(5) general polish. Full detail in `FUTURE-BACKLOG.md` "Web UI: pilot → product". **Possible follow-ups for the detect
feature (only if asked):** SSE-stream detection (paint cards as each resolves — Open Design's `?stream=1`); live model-list
probe (`codex debug models`) instead of the static catalog; a New Project registration-time agent picker (currently
Settings-only); reconcile a stale model when the adapter dropdown changes (a model not in the new adapter's catalog stays
in the draft until the user re-picks).

**DEFERRED — Desktop wrap (Electron/Tauri).** Operator (s25): NOT until the web UI is debugged + polished to a real
product. Additive when it comes; needs an IA/UX discussion first. Do not start early.

**Optional follow-ups (only if asked):** surface the verdict seal / token total in RunView task cards (currently only
the Inspector rail); a per-run usage tile on the RunView header consuming `getRunUsage`.

- **~~UI "today"/cross-run usage view + strip cost~~ — DONE (s25, PR #45 `c4fae71`; LIVE-PROVEN 2026-07-05).**
  SessionRail Tokens = this run / today / all-time via `useSessionUsage` over `GET /runs/:id/usage`; cost stripped
  end-to-end (backward-compatible). Live token-run on aurora rendered real 531.5k, `token-usage.json` de-costed,
  critic verdict `clean` 0.98.
- **~~codex critic `--json`~~ (candidate c) — ASSESSED & DECLINED at s24 end (operator agreed).** A subagent reconned the
  codex adapter: the verdict's authoritative source is the `-o` outfile, but stdout is the FALLBACK (`parseVerdict`
  outermost-braces) AND `parseCodexTokens` reads a bare `tokens used` footer — a full `--json` switch (JSONL event stream)
  breaks BOTH. The `--json` event schema is UNDOCUMENTED in-repo, so it needs an empirical `ADH_LIVE` capture to design
  safely. Two safe designs, both with a bad payoff: (a) a SEPARATE best-effort `codex exec --json` spawn just for usage —
  doubles the critic spawn (latency+cost) on every task forever; (b) single `--json` call with verdict re-pointed to `-o`
  only (drop the stdout fallback) — bets the gate on unverified CLI behavior. Reward is marginal — and now near-zero:
  the operator has said **cost is NOT wanted at all, token count only** (s24 end), so `--json`'s split+cost draw
  collapses while the gate risk stays. s22's spec already codified this as a bad trade. **Dead unless the operator
  specifically resurrects the token-split need — and only then after an ADH_LIVE `--json` shape capture.**

-2. **~~Server-side per-run usage aggregation `GET /runs/:id/usage`~~ — DONE (s24, PR #44 `8067022`).** Sums each task's
   `token-usage.json` server-side (the clean path for a cross-run "today" total). Follow-up if wanted: a UI view that
   calls it for a "today" cumulative (no client-side N×M fetch needed anymore).

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
