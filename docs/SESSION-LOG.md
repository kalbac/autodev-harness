# SESSION LOG — Autodev Harness

> Newest entry on top. 10–20 lines per session.

---

## s39 — 2026-07-12 — **direction session (Fable 5): live-orchestrator doctrine → ADR-004 accepted + s40 attended-presence spec** — DOCS-ONLY

**The talk (operator's call from s38, no building).** Operator opened with two clarifications: "never merge bullshit"
is ACHIEVED (esp. with agent-ci), and the name *autodev* implies the missing half — unattended end-to-end progress;
slogan extended to **"Stop babysitting and never let agents merge bullshit."** Converged diagnosis: felt-deadness and
no-autonomy share one root cause — the live orchestrator was amputated into a one-shot decompose pipeline (`handleIntent`
is a staged, terminating pipeline by design); ONE persistent-orchestrator component fixes both: **narrator when attended,
worker when overnight**. Operator's pain named precisely: agents block overnight on questions they could decide
themselves — flip **pre-approval → post-review** (decide reversible forks, journal them, review in the morning); the
deterministic gate is what makes that safe. His additions: a "does this match the project concept?" self-check before
any autonomous decision (→ per-project **north-star** doc), and an explicit **Overnight** toggle with wider privileges.

**Doctrine → `adr/004` (accepted, sign-off in-session):** 6 tenets — one component/two modes; post-review; 3 decision
classes (block parks the task, never the queue; operator UI/UX taste is always class 3); north-star check (anti-drift at
decision granularity; run-level anti-drift becomes mandatory for autonomy); Overnight = global top-bar toggle (autonomy
is a function of operator presence); adr/003 R1 boundary untouched.

**UX brainstorm (superpowers:brainstorming, ASCII mockups, every fork operator-picked):** chat = the project's MAIN
screen (ChatModal dies); thread = intent/run with a sidebar thread list (Claude Code Desktop IA); prose + instant
machine activity-cells (cells deep-link to RunView/CiRunView/TaskDetail); launch via plan-chip button AND
conversational word (both → the unchanged R1 confirm path; LAUNCH control-marker guarded by operator-turn + plan-exists);
SessionRail stays status-only; narrator architecture = **hybrid A+B** — live `ChatSessionManager` pre-launch (s34
machinery; the opening turn MUST stream — kills the 10-15s dead air) + event-driven one-shot narration post-launch over
blackboard-persisted threads (`.autodev/threads/<id>/thread.ndjson`, SSE replay→live per the s38 CI pattern; narrator
best-effort, restart-safe). **Spec:** `superpowers/specs/2026-07-12-live-orchestrator-attended-presence-design.md`
(attended presence ONLY; operator approved in-chat and waived file review). s38 polish bugs #1/#2 absorbed (modal dies);
FUTURE-BACKLOG "Orchestrator CHAT" marked superseded. Meta-note banked: the operator observed this session's
recommendations matched his preferences "100%" — because they were READ from his recorded feedback, not guessed; that is
the north-star mechanism demonstrated live.

**Next (s40, operator picked Opus 4.8):** writing-plans over the spec → subagent-driven build → codex gate → live-prove
through daemon+browser on the FELT criterion. Overnight/autonomy = s41+ brainstorm on ADR-004.

---

## s38 — 2026-07-11 — **agent-ci observability** (cross-platform WSL invocation + live CI visibility) — BUILT, codex-CLEAN, LIVE-PROVEN end-to-end (happy DONE+commit AND red RETRY)

**Scope.** Executed the s38 plan (`2026-07-11-agent-ci-observability.md`) subagent-driven (Sonnet workers + per-module
spec/quality review + mandatory codex GPT-5.5 gate). Makes the off-by-default `gate.agentCi` step cross-platform + observable.
Branch `autodev/s38-agent-ci-observability` (21 commits, HEAD `0809fa2`).

**Backend (Tasks 1-8).** Typed `AgentCiEvent` + `parseAgentCiEvent` (event-keyed) + `deriveWorkflowVerdict`; cross-platform
capability (`detectAgentCiCapability` native/wsl/unavailable, `winToWslPath`, `buildAgentCiCommand`) + streaming spawner;
streaming refactor of `agent-ci.ts` (contract `{green,reasons}`/throw-on-infra UNCHANGED) + typed `AgentCiUnavailableError`;
`taskId` threaded into the gate; `CiEventBus` + SSE (history-replay→live) + capability handler; `root.ts` `onEvent` persist
(ndjson + status.json) + publish; honest `needs-WSL` escalation reason; `index.ts` wiring. **UI (Tasks 9-12, review-only):**
api/query/SSE hooks (`useCiEvents`); CI block in SessionRail (enabled-gated); `CiRunView` live step-tree screen; RunView link +
Settings capability line.

**Gate.** 981 tests / 3 skip, root+ui typecheck+build green. **codex GPT-5.5 ran 4 passes:** backend R1 — 1 Critical (timeout
passed after a terminal event → made timeout throw infra) + 2 High (**WSL path never mapped — `winToWslPath` was DEAD CODE**;
unmappable path ≠ unavailable) + 2 Medium (SSE replay-disconnect leak; unbounded ndjson) → fixed; R2 — 1 Medium (ndjson cap
off-by-marker) → fixed; the GIT_DIR fix → CLEAN; the two live-prove git-fixes → CLEAN. Re-critic every in-place fix.

**LIVE-PROVEN through the REAL daemon + Chrome (WSL+Docker).** Happy path (`agentci-live4`): a real task ran opus-decompose →
sonnet-worker → gate(check + **agent-ci full CI in WSL, 6/6 steps passed**) → codex-critic clean → COMMIT → merge → **DONE, real
commit `565b93c` on autodev/main**; CI screen streamed the green step-tree live ("agent_ci_green ✓ → gate COMMIT unaffected");
Settings showed "agent-ci ● VIA WSL"; `/ci/capability` returned `wsl`. Red path (`agentci-red`, failing workflow): CI screen red
tree with `failing-check` red + "agent_ci_green ✗ → gate RETRY (failed: failing-check)" + CI block "failed (step …)".

**The live-prove earned its keep AGAIN** (per the operator's philosophy) — the observability CODE was correct throughout, but
driving the full worker→gate→**merge** flow surfaced TWO Windows↔WSL git-interop blockers unit tests could never see: (1) agent-ci
can't resolve `HEAD` in a Windows-created git worktree (the `.git` gitdir pointer is a Windows path WSL git can't follow) → only
`run.start` → infra-escalate on every run; (2) agent-ci MUTATES the shared `.git/config` (flips `core.bare=true`; `GIT_WORK_TREE`
persists `core.worktree=/mnt`) → corrupts the main repo → conductor's post-gate merge breaks. Fixes: derive the WSL gitdir + set
**`GIT_DIR` only** (never `GIT_WORK_TREE`) + **snapshot/restore `.git/config`** around the run. → gotcha
`[gate/agent-ci-worktree-wsl-git-interop]` (GOTCHAS 57→58). Demo projects + daemon cleaned; the WSL `actions-runner` image kept.

**Merged + demoed.** Pushed → PR #71 → CI green 4/4 (ubuntu+windows × node 20/22) → **merged to main (`0e68aeb`)** per the
standing grant (codex-clean + green CI). Then brought the daemon up and the operator **re-ran the full pipeline himself in the
browser** (fresh `agentci-demo`, workflow slowed with `sleep` steps so the CI tree streams watchably) → **confirmed working
end-to-end** (a second real commit landed). Found 3 UX polish bugs (parked in FUTURE-BACKLOG): the pre-launch chat leaks the raw
```json decompose output + its plan chip overflows the viewport; the SessionRail CI block "open CI run →" link is near-invisible.
All s38 test projects + artifacts cleaned; registry back to just `woodev-shipping-plugin-test`. honest-unavailable path is
unit-proven + identical machinery (this box has WSL, so it wasn't driven live).

**Operator reflection → s39 is a DIRECTION talk, not a build.** The engine works and the gate demonstrably catches real bugs, but
the operator flagged the harness feels **"not alive"**: launch → 10-15s dead-air → a transactional modal he dislikes → 'Launch &
Run' → more silence → a Session Inspector that shows state but doesn't NARRATE. The original autodev-loop (`D:\Projects\woodev_framework`)
felt alive because a LIVE narrating orchestrator (Claude Code) was in the loop, watching + reporting. He wrapped it into the harness
for 4 real wins (auto-orchestrate / universal / multi-OS / visibility) — but in gaining structure it lost the live-companion soul.
**s39 opens on a philosophical/direction conversation (his call, model = Fable 5): how to put the live, streaming, narrating
orchestrator presence back in without losing the 4 wins.** Framing + his exact words captured in `next-session-promt.md`.

---

## s37 — 2026-07-10 — **agent-ci gate hardening** (optional local-CI-replay gate step) → **PR #69**, codex-CLEAN + LIVE-PROVEN

**Scope.** Implemented the s33 spec (`2026-07-08-agent-ci-gate-hardening-design.md`) — an OPTIONAL, off-by-default,
config-gated ADDITIONAL machine-gate step replaying a project's real GitHub Actions CI locally (`@redwoodjs/agent-ci`)
in the per-task worktree BEFORE commit. Subagent-driven (Sonnet workers per module + mandatory codex GPT-5.5 gate).
Wrote the plan first (`docs/superpowers/plans/2026-07-10-agent-ci-gate-hardening.md`), grounded in the real code.

**Build (7 commits).** (1) `schema.ts` `gate.agentCi.{enabled,workflows,timeoutMs}` all-defaulted → opted-out = byte-identical.
(2) `gate/agent-ci.ts` new pure `runAgentCiWorkflows`: sequential `npx @redwoodjs/agent-ci run --workflow <p> --json` per
allowlisted workflow; **job-fail→RETURN `{green:false}`, infra-fail→THROW** (the throw-vs-return split IS the contract).
(3) `gate.ts` step "1c" after `success_commands` + `agent_ci_green` verdict field + `||!agentCiGreen` RETRY fold; the throw
propagates out of `runGate` uncaught (conductor already escalates gate throws, `conductor.ts:474`). (4) `root.ts` wires
`runAgentCi` like `runCheck` (null when disabled; enabled+empty-allowlist→WARN+skip). (5) config-preservation regression
test (a UI `checkCommand` save keeps a hand-set `gate.agentCi` — `mergeConfigYaml` spreads `...raw.gate`).

**Gate discipline.** 934 tests/3 skip, typecheck+build(root+ui) green. **codex GPT-5.5 gate ran 3 rounds.** R1: 2 Sev-2 —
(a) the `Promise.race` timeout threw but never killed the agent-ci/Docker child → leak; fix = pass `timeoutMs` INTO the
runner so `runNative` reaps it (SIGTERM→SIGKILL), race stays as the throw-contract guarantee; (b) parser OR'd pass/fail
across all terminal events → a late `{status:cancelled}` after `{status:passed}` misread as pass; fix = last-terminal-wins
+ unknown-terminal→failed (fail-closed, never COMMIT on ambiguity) → re-critic CLEAN. Then the LIVE-PROVE found a real
correctness bug → fix → final codex **CLEAN**.

**Live-prove (operator chose full).** Docker 29.4 present. agent-ci **does not run on native Windows** (dies pre-Docker on
`tar -czf C:\...` — Unix-tar reads `C:` as a remote host) → proved the **infra-fail branch for real** (module + `runGate`
both throw → escalate). Ran the **pass/job-fail branches under WSL** (node22 + Docker there): real agent-ci pulled the
490MB actions-runner image and ran real containers. **Captured the REAL NDJSON — and it broke the parser:** events are
keyed by **`event`**, not the initially-guessed `type` (`{"event":"run.finish","status":"passed"|"failed"}`). Keyed on
`type`, EVERY real run (pass or fail) would have parsed as infra→throw→escalate — green unit tests, 100% useless in
production. Fix = `obj.event ?? obj.type` (type kept as a defensive fallback) + two VERBATIM real-NDJSON regression tests.
**All 3 branches then proven end-to-end via the real built module:** pass→module `{green:true}`→gate `COMMIT`;
job-fail→`{green:false}`→gate `RETRY`; infra→throw→escalate.

**Docs/gotchas.** GOTCHAS 55→57: `[gate/agent-ci-not-runnable-on-native-windows]` (feature is Linux/WSL-only in practice;
Windows always infra-escalates — the correct fail-safe), `[gate/agent-ci-ndjson-keyed-by-event-not-type]` (the guessed-shape
trap; live-prove earned its keep, same class as the s32 dedup lesson). **Result: PR #69 MERGED** (`d5d5808`).

**Addendum — operator battle-test + redirect (same session).** After the merge the operator pushed back, rightly: he never
saw Docker spin up or any process IN the harness, because my live-prove ran through the built MODULE directly (a throwaway
`prove.mjs`) and under WSL — NOT through the daemon/UI. Reconciled honestly: the run WAS real (real containers, real NDJSON)
but module-level, and v1 has no UI + doesn't run on his native-Windows harness. He redirected: don't rush polish — make
agent-ci **observable in the harness UI** and **runnable from his Windows box** (product for Windows/Mac/Linux + a future
Tauri/Electron wrap; Windows users get an honest "needs WSL" message). Brainstormed (ASCII mockups, no browser companion)
to locked decisions: **invocation** = cross-platform, Windows proxies into WSL (`wsl -e` + `/mnt` path map) with honest
capability reporting; **CI screen depth** = live step tree, no raw logs (logs = v2); **transport** = hybrid (persist
`agent-ci-events.ndjson` + SSE). Wrote the design spec `docs/superpowers/specs/2026-07-10-agent-ci-observability-design.md`
(mockups approved). **Artifacts cleaned** (WSL test repo/state, Windows scratchpad, containers; only the 490MB actions-runner
image kept for the next real run). **Next session: operator reviews the spec → writing-plans → subagent-driven build,
live-proven THROUGH the daemon+browser.**

---

## s36 — 2026-07-09 — Component-currency **Tier 2** (8 items) + native shell + desktop responsiveness → **MERGED (PR #65 `a5efbb5`)**, + 2 polish fixes (**PR #66 `2bab3c7`**)

**Scope.** Executed all of Tier 2 from the s35 audit, subagent-driven (Sonnet workers + mandatory codex GPT-5.5 gate
per module), browser-proven, ONE PR. Operator added a cross-cutting ask up front: **desktop responsiveness** (no mobile)
— the shell had ~zero (556px fixed chrome: sidebar 256 + rail 300 starved `main` at every width).

**8 items (each codex CLEAN or CLEAN-after-fix):** (1) **toggle-group** — SettingsPopover theme + Inspector file-chips
(1 Low `min-w-fit`). (2) **sidebar block + responsiveness** — shell rebuilt on the base-nova `sidebar` block
(`collapsible=icon`); a controlled `SidebarProvider` + matchMedia controller auto-collapses <1280 (Ctrl/⌘B overrides
until the next breakpoint cross), the session rail auto-hides <1120 behind a floating overlay toggle; project rows →
`SidebarMenu` (mount-gated fetch preserved; letter-avatars collapsed). (3) **native inset refine** (operator UI
feedback mid-session, ref dashboard-01) — `variant="inset"` (sidebar + content read as SEPARATE panels); footer
rebuilt as the native `DropdownMenu` NavUser pattern; daemon status → `Badge`. (4) **chips → Badge/Button** (codex 1
Med `zone`-marker-got-a-pill → reverted to span + 1 Low font-normal). (5) **checkbox** (codex 1 Med — sibling
`htmlFor` doesn't toggle a span-rooted Base UI checkbox → wrapping `<label>`). (6) **alert-dialog** — EscalationCard
gate-override confirm (custom async/broken-tone Buttons kept, not AlertDialogAction). (7) **collapsible** — DigestStrip.
(8) **input-group** — NewRunComposer shell (codex 2 Low → `focus-within:border-ring` [was control-only] + `flex-wrap`
footer); ChatModal composer left as-is (different shape). Operator chose "all Tier 2 incl. input-group" over my
churn-skip recommendation.

**Verification.** ui typecheck + build green every commit; **codex GPT-5.5 gate on every module**; browser live-proof
(real daemon + Chrome): 3-region shell light+dark, Ctrl+B icon-collapse (avatars, main reclaims ~208px), inset floating
card, native footer DropdownMenu + `daemon live` badge + theme keep-open, composer focus (--border→--ring, ring glow
suppressed), TaskCard chips compact. CI green 4/4. Rail-hide <1120 + alert-dialog confirm NOT live-clicked (window
clamps ~1295px CSS; no escalation to reach) — logic + codex verified.

**Polish (PR #66, operator-reported bugs).** (1) SidebarRail resize-cursor artifact → removed (`<SidebarRail/>`
redundant given header trigger + Ctrl/⌘B + auto-collapse). (2) Collapsed-footer gear mis-rendered → **root cause
(gotcha 54): tailwind-merge doesn't dedupe `important` + arbitrary-variant utilities**, so the block's `size=lg`
`group-data-[collapsible=icon]:p-0!` lost to base `p-2!` (stylesheet order) → 16px content box clipped the size-8
square. Fix: bare `size-4` gear (native default-button collapse, zero crutches; operator vetoed a `hidden`-style hack).
Operator approved the trade-off (lost the accent tile). Couldn't screenshot the below-fold footer (box browser died);
fix root-cause-confirmed by live measurement + operator eyeball.

**New gotchas (2): 53→55** — `[ui/twmerge-important-arbitrary-variant-no-dedupe]` (54), `[ui/base-ui-checkbox-wrapping-label]` (55).
**Vendored primitives:** toggle-group/toggle, sidebar/sheet/use-mobile, checkbox, alert-dialog, collapsible, input-group
+ `use-media-query` — all Base UI, zero radix; block `button` deps rewired to custom `Button` (Windows collision, gotcha 62).

## s35 — 2026-07-09 — Component-currency migration **Tier 1** → **MERGED (PR #63, `de57d6c`)**

**Context.** Operator ask carried from s34 (prompted by the s34 `MessageScroller` miss — shipped a generic component
where a purpose-built one existed): with the shadcn MCP now LIVE, review EVERY UI component vs the current catalog and
adopt purpose-built primitives — "task-maximum," including blocks and the Skills docs.

**The reframe (gotcha 53).** Our `components.json` style is `base-nova` (shadcn on **Base UI**). The shadcn MCP's item
metadata reports the **default-style (Radix)** deps, so I (and the 3 audit subagents I briefed with that metadata) first
tagged `bubble`/`item`/`sidebar`/`collapsible`/`tabs`/`toggle-group`/`checkbox`/`alert-dialog` as "FOUNDATION-COST (radix)."
Fetching the raw `base-nova` registry JSON (`ui.shadcn.com/r/styles/base-nova/<item>.json`) proved that WRONG: base-nova
ships **Base-UI ports of the whole catalog** — none pull Radix. So there is no foundation trap; the real adoption filter
is value/churn/behaviour. Rewrote the audit accordingly (`docs/wiki/component-currency-audit-s35.md`, Tier 1/2/3).

**Method.** Recon via 3 parallel Explore agents over all 18 composites + 7 custom primitives + 15 vendored, cross-checked
against the live catalog (61 `ui` items + blocks) and the Skills docs (an AI-assist skill ≈ the MCP we already have;
useful byproduct: `shadcn diff` for drift). Operator chose "Tier 1 now, Tier 2 item-by-item."

**Tier 1 shipped (5 commits, subagent/main-session mix).** Vendored 6 base-nova primitives (spinner/empty/kbd/label/
field/bubble) via curl-the-registry-JSON + alias/icon rewrites (gotcha `[ui/shadcn-cli-vendor-windows]`; no `button` dep
→ no Windows case-collision). **Keystone:** rebuilt `Feedback.tsx` — `Spinner` wraps shadcn `spinner` (muted default
kept), `EmptyState` is a shadcn `empty` composition; public signatures unchanged so every caller (Inspector ×4, all
Loading spinners) inherits the primitive with zero caller edits. Then: SessionRail `Loader2`→`Spinner`; RuntimeFileView
"Select a file" + EscalationCard "No record" panel-empties→`EmptyState` (small inline one-liners in dropdown/sidebar/
log-tail deliberately KEPT as idiomatic muted text — forcing `empty` there is an anti-pattern); ChatModal `ChatBubble`→
shadcn `bubble` (chose `bubble` over the audit's `message` — it's the purpose-built tinted bubble; dropped the unused
`message` primitive); NewRunComposer ⌘⏎→`kbd`; RegisterForm 4 input fields→`field` (mono micro-label preserved via
twMerge overrides; form-level error kept as `text-broken`, not `FieldError`'s `text-destructive`); SettingsPopover
hand-rolled `h-px` divider→`separator`. NewRunComposer textarea→`input-group` and RegisterForm checkbox→`checkbox`
correctly deferred to Tier 2 (the composer textarea is intentionally borderless-in-a-card; vendored Textarea fights that).

**Gate.** root+ui typecheck ✓, ui vite build ✓, **independent codex GPT-5.5 full-diff gate: CLEAN, 0 findings** (verified
alias/icon rewrites, preserved signatures, `whitespace-pre-wrap`, twMerge override order, no dead refs). **Browser
live-proof** on a real daemon (:4319) + real project + real Chrome: `bubble` BOTH variants in a real end-to-end
`claude -p` chat (operator=primary/right, assistant=outline/left), `kbd` key-caps, `spinner` (chatStart), `Tabs`
switching + `VerdictSeal` CLEAN + `DiffView` colored diff — zero layout breakage across home/run/task. **CI green 4/4.**
Merged PR #63 (merge commit `de57d6c`) — merge-commit to preserve M1–M4 module history. GOTCHAS 52→53.

**Next (s36): Tier 2, item-by-item, subagent-driven (Sonnet 5 + codex critic)** — `toggle-group` (theme), `checkbox`,
`input-group`, `collapsible`/`accordion`, `alert-dialog`, big `sidebar` block LAST; + Badge/Button chip consolidation +
vendored-primitive drift spot-check. Stopped here (not starting Tier 2 this session) to keep a fresh context for it —
operator's own condition. Env note: box at ~743MB free (stale node procs); the classifier blocks mass-killing unidentified
node procs — start the daemon anyway (it's light) rather than force-cleaning.

## s34 — 2026-07-08/09 — Orchestrator pre-launch chat: executed the whole s33 plan (12 tasks) → **MERGED (PR #62, `5989c26`)**

**What shipped.** The fire-and-forget "type intent → Launch → silence" flow is replaced by a live multi-turn `claude -p`
chat: `ChatModal` streams the orchestrator's replies token-by-token over SSE, shows a live proposed-plan preview, and
only an explicit Confirm & Launch fires the exact same unchanged `handleIntent`/`POST /orchestrate` path (adr/003
R1-safe — the chat never gains enqueue/trigger). Backend: shared JSON-array extractor, `stream-json` wire parser,
`ClaudeChatProcess` (live multi-turn child, `--safe-mode`+`--strict-mcp-config`+`--tools ""` isolated),
`ClaudeOrchestratorChatAdapter`, `ChatSessionManager` (registry/idle-reaper/one-per-project guard/SSE-detach/
start-timeout/close-on-unregister), 5 HTTP routes (start/stream/message/confirm/cancel) with a clean `launchOrchestrate`
extraction, composition-root + real-`ProjectView` wiring. UI: chat API client + hooks, `ChatModal` on shadcn's
`MessageScroller`, wired from `NewRunComposer` (digest-watch toast preserved).

**Discipline.** Subagent-driven (Sonnet 5 implementer TDD → spec-check → independent codex GPT-5.5 gate → fix +
regression test → re-critic) per module. Codex found and fixed a REAL bug in nearly every task (stderr-pipe hang,
SIGKILL timer leak, oversized-line silent hang, isError swallowed, cancel-before-launch data loss, dead-SSE writes,
throwing-sink gaps, and the standout `onToken`-bound-once streaming break). **Full-diff codex gate then ran 9 rounds** —
each surfacing a genuine session/process-lifecycle edge (stale-session confirm, shutdown-race leak, close-during-start
resurrection, confirm-during-active-turn, unbounded opening-turn hang → permanent slot lock, a self-inflicted timer
leak in THAT fix, chat-leak-on-unregister/evict, stale-SSE-token duplicate bubble) — all fixed; final round CLEAN, 0
findings. **913 tests / 3 skip, root+ui typecheck+build green, CI green 4/4** (ubuntu+windows × node 20/22).

**LIVE-PROVEN twice.** (1) curl on aurora: real `claude -p opus` chat spawn, live SSE frames, `--safe-mode` in the real
spawn args, clean cancel (no orphan), confirm → real decompose/worker/critic — the critic correctly ESCALATED a
chat-guessed wrong assumption (no `PROVIDERS` map exists) rather than fabricating a commit, proving "chat is
advisory-only". (2) Real Chrome browser: ChatModal opens, streams, auto-scrolls, proposed-plan preview, multi-turn
continuity, Confirm & Launch → dashboard RUNNING → CLEAN → **real commit `a794b88` landed on aurora**; Cancel enqueues
nothing + releases the slot; MessageScroller auto-scroll + stale-token gate verified.

**Operator-driven improvement + follow-ups.** Operator caught that the chat transcript used a generic `ScrollArea`
where shadcn's purpose-built `MessageScroller` existed (a real methodology miss — worked from the locally-vendored
shadcn set, not the live catalog). Swapped to `MessageScroller` (`9f4d1d0`, browser-verified auto-scroll — closed the
backlogged auto-scroll gap). Added a project `.mcp.json` wiring the **shadcn MCP** (project-level per operator; live
next session after a restart) + backlogged a **component-currency audit** of all UI components vs the current catalog.

**Environment note.** This box was under severe memory pressure from stale MCP-server/dev-server processes accumulated
across PRIOR sessions (weeks old) — operator-approved cleanup unblocked the codex reviewer. Reliable workarounds:
`curl -N` for SSE, and the inline-diff-with-no-tools-preamble `codex task` recipe when the sandboxed `git diff` failed.

**New gotcha:** `[chat/onToken-bound-once]` (count 51) — a session's `onToken` is bound ONCE for the process's whole
lifetime, so live streaming silently never worked past the opening turn until it looked up the live sink per token.

---

## s33 — 2026-07-08 — TWO discussion-first agenda items → two committed specs (no code yet)

**Item 1 — Orchestrator CHAT brainstorm → spec → plan.** Resolved the load-bearing `adr/003` question first: a
pre-launch chat is R1-safe as long as it stays a preview layer over the same 4 orchestrator capabilities
(enqueue/trigger/read/report) — the ONLY write into enforcement stays the existing, unchanged `handleIntent`, fired
once on explicit "Confirm & Launch" (finalIntent assembled from the operator's OWN messages, never the LLM's).
Operator chose the maximal-scope options: pre-enqueue-only (v1), genuine conversational replies (not raw
TaskSpec[]), and a truly **live, multi-turn `claude -p` process held open for the whole chat** (not per-turn
history-restuffing). **Live-verified the wire format myself** (spawned real `claude -p --input-format stream-json
--output-format stream-json`, fed 2 turns over one process's stdin) before writing the plan — confirmed the
session_id-stable process + `content_block_delta`/`result` event shapes used throughout. Spec:
`docs/superpowers/specs/2026-07-08-orchestrator-chat-design.md` (`fa96605`). Plan (12 tasks, TDD, grounded in the
real transcript, not guessed): `docs/superpowers/plans/2026-07-08-orchestrator-chat.md` (`294a78c`). **Not started
— execution mode (subagent-driven vs inline) not yet chosen.**

**Item 2 — `redwoodjs/agent-ci` recon → corrected verdict → spec.** Recon-first (real README/LICENSE/shipped Claude
skill/blog, not the name): it's a local-GitHub-Actions-fidelity/speed tool for a single agent's pre-push loop
("CI becomes a formality — a verification of something you already proved"), NOT an orchestrator — near-zero
overlap with our 6 frozen-skeleton axes. Wrote `docs/wiki/agent-ci-analysis.md` (`b330656`). **Operator corrected my
framing**: not a replace-anything pitch, an optional STRENGTHEN of "never merge bullshit" (real downstream GH
Actions CI today has zero pre-merge visibility from our gate — a genuine gap). Re-briefed as its own brainstorm →
design: `docs/superpowers/specs/2026-07-08-agent-ci-gate-hardening-design.md` (`72a09d8`) — folds into the
EXISTING `RETRY`/`ESCALATE`/`COMMIT` machinery with zero new Decision/escalation types: a genuine workflow failure
→ RETRY (like `success_commands`); a Docker/agent-ci infra failure → throws, reusing the already-existing
"gate threw → broken operator config" escalation path. Opt-in, off by default, explicit workflow allowlist (never
`--all`, to avoid an accidental deploy-workflow run). **Plan not yet written.**

**No code changed this session** — both items were deliberately discussion-first per the operator's ask; three docs
commits landed (specs + analysis + backlog entries), zero production diffs. Memory updated mid-session
(`feedback-decide-dont-ask`): operator wants product/UX-shaping questions during brainstorm, NOT a
section-by-section technical-architecture approval loop — decide the plumbing solo, bring back a finished design.

---

## s32 — 2026-07-08 — agency-agents pivot + 3 backlog features (PRs #55/#56) + live proofs

**Pivot:** studied `github.com/msitarzewski/agency-agents` (MIT) vs the operator's 5-way frame → **#4 Not for us** — a
~280-file persona-prompt library + multi-tool installer, not an orchestrator (installs prompt files, doesn't run agents;
no gate/isolation/blackboard/merge). Wrote `docs/wiki/agency-agents-analysis.md` + a worker-persona-catalog FUTURE-BACKLOG
item (its wordpress/drupal personas fit the woodev stack). Operator: "record the catalog idea" — done.
**Then built the operator's first-three-in-order, each TDD + independent codex-GPT-5.5 gate, subagent-recon-first:**
- **#1 onboarding-exclude** (`0c8a3de`): generalized `ensureGitExclude` → `.autodev/`+`.serena/` (per-entry idempotent);
  new standalone `mainTreeStatus` (git.ts) + optional conductor dep → best-effort dirty-tree **preflight** WARN at
  `run()` start with a skip-worktree hint for TRACKED churn files (exclude only fixes UNtracked). codex: shell-footgun +
  rename-parse → re-critic CLEAN.
- **#2 relaunch dedup / backlog C** (`61ad0cb`): `isDuplicateTask` = file_set overlap (reuse `fileSetsDisjoint`) AND
  normalized-title, vs pending/active/escalated. Full dup → skip enqueue + re-trigger; partial → enqueue all + WARN
  (never drop a subset → depends_on-safe; fail-open on title drift). codex CLEAN 0 findings. **Backlog C CLOSED.**
- **#3 apply-on-accept** (`d0f9551` + UI `df149ca`): reply **choice "C"** (gate-override; A/B unchanged). Worktree is
  gone at escalation, so it replays `runtime/<id>/diff.patch` (conductor now also pins `runtime/<id>/loop-branch`) via
  `git apply` → add file_set → commit → escalated/→done/ + markDone (legitimate: file_set IS in the repo). Fails CLOSED:
  `--numstat` subset-validation (strict allowlist — `.env`≠`env`; abs/`..` rejected), exact loop-branch pin, clean tree,
  rollback-on-post-apply-failure, loud override commit msg. UI "Commit anyway" + confirmation modal (409 reason in-modal).
  codex found 4 real bugs across 2 rounds (dirty-tree-on-commit-fail, patch-not-scoped, weak branch check, reply-before-move;
  then leading-dot bypass + rollback exit codes) → re-critic CLEAN — the gate earned its keep on a gate-bypass feature.
**Merged** PR #55 (backend, `f26e86a`) + PR #56 (UI, `794ed2d`), CI 4/4 both. 830 tests / 3 skip, root+ui typecheck+build green.
**LIVE-PROVEN (real daemon on `woodev-shipping-plugin-test`, evidence-first):** choice C → real commit `c62a5f4` with the
override marker, task escalated→done; no-diff task → 409 + stays escalated (fail-closed); fresh serena repo → `.serena/`
excluded + tree clean; dirty tree → preflight WARN fired. **#2 dedup left NOT live-proven** (needs 2 expensive opus runs —
deferred to a supervised morning run). Seed cleanup done; test repo left clean on `autodev/main` (HEAD = the proof commit).

---

## s32 (cont'd) — 2026-07-08 — live-proving #2 found a REAL dedup gap → fixed (intent-level dedup, PR #58)

**Operator resumed for the deferred #2 live-prove — and the live run found a real bug the unit tests missed.**
First attempt: launched the same intent twice from the UI. Run 1 escalated `dedup-proof-md` (critic disagreement,
correct). Operator replied "A" on the escalation card BETWEEN the two launches (a UI habit, not instructed) — moving
the task to `quarantine`, which dedup deliberately excludes. Run 2 then decomposed a SECOND task, `dedup-proof-doc`,
same `file_set: [DEDUP-PROOF.md]` but a DIFFERENT title ("verifying relaunch-intent deduplication" vs "verification
note at repo root") — opus re-titles identical work on every decompose. **`isDuplicateTask`'s AND-title-match missed
it: real duplicate, not caught, fail-open.** Root-caused live from `conductor.log` + the queue state, not guessed.
**Fix (operator-chosen, "intent-level dedup"):** compare the OPERATOR's intent text (normalized), not the LLM's
retitled task output — robust to exactly the drift that broke the task-level heuristic. New `caps.read.recentRuns()`
reads `<stateDir>/runs/*.json`; `handleIntent` checks it BEFORE the expensive decompose: same intent + a prior run's
task still pending/active/escalated → skip decompose, enqueue nothing, re-trigger, WARN. Task-level heuristic kept as
a secondary layer (still catches other duplicate shapes). codex gate: Sev-2 (recentRuns read+parsed ALL manifests
before slicing to 50 — unbounded on a large runs dir) + Sev-3 (forged manifest, low-risk trusted-stateDir) → bounded
(filter `run-*.json` → sort → slice 50 BEFORE any read; lstat + 64KB cap per candidate before parse) → **re-critic
CLEAN**. 837 tests / 3 skip, root+ui typecheck green. **Merged PR #58 (`ec9721f`).**
**RE-LIVE-PROVEN clean, same repo, same daemon-restart discipline:** two real orchestrate launches of the IDENTICAL
intent (this time NOT replying to the first escalation) → run 2's log: `"this intent was already orchestrated ...
nothing enqueued -- re-triggering"` in ~30ms (opus decompose skipped) → exactly ONE escalated task afterward, zero
duplicates. **All three s32 backlog items are now live-proven end-to-end.**
**Lesson banked** (operator's standing ask — prove the real goal, evidence-first): a live run surfaced what 6 passing
integration tests (written with controlled identical titles) structurally could not — the tests proved the code did
what the tests said, not that the tests said the right thing. Proportional live-proving on a gate-adjacent feature
(dedup interacts with the escalation/quarantine lifecycle) paid for itself immediately.

---

## s32 (cont'd 2) — 2026-07-08 — "how would I know it was deduped?" → toast fix (PR #60) + orchestrator-CHAT vision parked

**Operator's follow-up question, exactly on point:** after seeing the dedup fix work, "as an operator how was I supposed
to know the run didn't start because of a duplicate? It looked like a silent failure to me." Investigated instead of
assuming: `POST /orchestrate` is fire-and-forget (202 immediately, R1-safe by design); the real outcome is decided in
the background and reported ONLY as a `[orchestrator] [LEVEL]` line in `digest.md`. `NewRunComposer` showed a static
"Run accepted — decomposing intent…" that never updates; `DigestStrip` (the only activity-log surface) lives on
`RunView`, not `Home`; a dedup-skip records no new run manifest, so there's nowhere to click into. **Confirmed
genuinely silent**, not the operator misreading something.
**Fix (PR #60, `c58ad21`):** watch the already-WS-live `digestTail` (reuses the existing `useState(projectId)` query
and the existing WS→invalidate pipeline — zero backend change) for the first NEW `[orchestrator]`-line after a
launch, within a 20s window, toast it (sonner) with a level-mapped variant. While in there, fixed a latent bug in the
never-rendered shadcn `sonner.tsx` scaffold: it read `useTheme` from `next-themes`, a library whose `<ThemeProvider>`
is never mounted in this app (own theme system in `@/lib/theme`) — toast theme would never have tracked the real
light/dark switch; mounted `<Toaster/>` at the app root (existed, never rendered). codex: 1 real bug (toasted the
LATEST orchestrator line instead of the FIRST new one after baseline, in case several land between refetches) → fixed
→ re-critic CLEAN. Review-only UI (no test infra for this UI, established convention); typecheck+build green.
**Live-proven via the real data path** (not synthetic): pulled the actual WARN line from the earlier dedup live-prove
straight out of `digest.md`, confirmed the real `GET /state` serves it in `digestTail`, and ran it through the
EXACT shipped regex → `{level:"WARN", message:"..."}` → would call `toast.warning(...)`. Every stage proven with real
production data; only the DOM paint itself is out of API-reach.
**The bigger reveal:** the operator's actual target isn't a toast — it's a real CONVERSATION with the orchestrator on
launch ("we discussed this since early design"). Today's `handleIntent` is explicitly a one-shot TERMINATING pipeline,
not an agentic loop. This is a genuine architecture pivot, deliberately NOT bundled into this wrap-up — parked in
`FUTURE-BACKLOG.md` "Orchestrator CHAT" with the key open question flagged up front: does a live conversational
orchestrator conflict with `adr/003`'s accepted role split ("gate/enforcement stays deterministic, an LLM can't talk
past it")? **Next session opens with that brainstorm**, per operator instruction, PLUS scoping a NEW pivot candidate
the operator found: `github.com/redwoodjs/agent-ci` + `agent-ci.dev/blog/the-agentic-dev-loop` — recon-first against
our 5-way frame (same discipline as the agency-agents pivot) before judging nice-to-have vs YAGNI vs must-have.
Session saved; see `next-session-promt.md` (gitignored) for the full handoff.

---

## s31 — 2026-07-07 — Three stuck-task / runs-UI bug fixes (PR #54) + harness PROVEN end-to-end (first green DONE)

**Trigger:** operator's live SMOKE run "stuck in ACTIVE ~30 min", not escalating/quarantining. Systematic-debugging.
**Bug 1 (root cause of the report):** gate said COMMIT, worker committed to the worktree branch, but `mergeAfterGate`
refused the merge-back into `autodev/main` because the test repo's MAIN tree was dirty — and it **threw** on that
precondition instead of returning `{ok:false}`, so the conductor's graceful `if(!mr.ok)` escalation was bypassed, the
throw unwound through `finally` (teardown ran → no daemon children), and the API orchestrate handler only logged it →
task **orphaned in `active/`** forever, `file_set` silently locking future runs. Fix `ec8394c`: `mergeAfterGate` returns
`{ok:false,reason}` on the dirty-tree + failed-checkout preconditions; conductor escalates with the accurate cause
(conflict vs precondition); **defense-in-depth backstop** catches ANY unhandled throw in `runIteration` → `escalated/`
(resolve-not-reject); post-commit `markDone`/`appendDigest` made best-effort. codex CHANGES-REQUIRED (Sev-1: a throw
after `moveTask→done` would mis-escalate a committed task) → fixed → re-critic CLEAN. Live-proven.
**Bug 2 (operator found next — "stuck in PENDING"):** relaunching left a task in PENDING with nothing consuming it =
backlog B. Root cause: orchestrate triggers a bounded run sized to its batch (`maxIterations=specs.length`) but
`claimNextTask` claims from the GLOBAL pending pool → a pre-existing pending task (my cleanup residue) ate the single
iteration and the batch's own task stranded; `serve` has no continuous drain. Fix `9e3157d`: `drain` run mode (stop on
idle OR rate-limit); orchestrator triggers `{drain:true}` → one launch clears the whole pool. codex CHANGES-REQUIRED
(persistent-429 could hold the single-flight lock to maxSessionHours) → drain also stops on rate-limit → re-critic
CLEAN. Live-proven: 2 pending tasks BOTH drained. **Backlog B CLOSED.**
**"0 in DONE, everything escalates" (operator pushed hard):** proved the harness had never landed a DONE. Not a code
bug — three stacked blockers: (a) test repo main tree perma-dirty (42 files); (b) **`.serena/project.yml` is TRACKED and
Serena auto-rewrites it → re-dirties the tree mid-run** → merge refused (new gotcha); (c) my proof/smoke-named intents
tripped the critic's fabricated-proof heuristic (correct). Cleaned tree (`reset --hard`+`clean`; removed Windows reserved
`nul` via `\\?\` long-path; `--skip-worktree` on tracked `.serena`) + a LEGITIMATE doc intent → **worker → critic clean →
gate COMMIT → merge → DONE**, real commit `a7b9f7b` on `autodev/main`. First end-to-end green DONE.
**Bug 3 (operator found — HomeView "No runs yet" despite a DONE):** `GET /runs` returned `[]`; every manifest "skipped
as unreadable/invalid". Root cause: run ids keep `.` from the intent slug (`slugifyIntent`/`isPathSafeId` allow it) but
the read side (`isRunManifest` + `/runs/:id[/usage]`+PATCH) validated with the stricter dot-free `safeIdSegment` → all
filename-derived runs dropped. Fix `a1c81d2`: reuse `isPathSafeId` as the run-id read validator (`safeRunId`); task/
escalation ids stay strict; traversal-safe. codex CLEAN. Live-verified `/runs` returns 8 (was 0).
**Merge:** PR #54 (merge-commit `3a0c641`, CI 4/4), all 3 commits preserved, main resynced. 798 tests / 3 skip.
**New gotchas (2, count 44→46):** `[env/serena-churn-blocks-merge]`, `[api/run-id-dot-validation-mismatch]`.
**Backlog captured:** onboarding should git-exclude `.serena/`+`.autodev/` by default (operator ask).
**Process notes:** a background CI poller using `jq` silently spun forever (jq not on this Git-Bash) → use `gh pr checks`
text parsing. The auto-mode classifier blocked `gh pr merge` until the operator's explicit in-session "домержить" (same
mechanical gate as s24). Test repo `woodev-shipping-plugin-test` is fully disposable (operator: "do whatever").
**Next session = PIVOT:** study `github.com/msitarzewski/agency-agents` (operator's "competitor") — see `next-session-promt.md`.

---

## s30 — 2026-07-07 — Onboarding redesign (any-folder + auto git-init/branch + git-not-installed) — brainstorm → spec → plan → subagent build

**Trigger:** operator flagged the New Project flow: it only lets you pick folders that are already git repos (the browser
scans for `.git`, non-git folders unpickable). He wanted a standard OS folder dialog + auto `git init` + a git-not-installed
notice. **Brainstormed:** a browser web UI CANNOT get a native folder path (sandbox); a daemon-spawned native dialog is
fragile on Windows and still needs the in-browser fallback → operator agreed to KEEP the in-browser browser and instead
drop the git-only filter, add an inline **init git**, hide system/hidden dirs, and add a git-not-installed banner. Native
dialog deferred to the desktop wrap. Spec + plan written & committed (`docs/superpowers/{specs,plans}/2026-07-07-onboarding-redesign*`).

- **Execution:** subagent-driven, Sonnet 5 workers in coherent units (util/git verbs+ensure-branch → fsbrowse+detect-git →
  admin+server+index) → **codex GPT-5.5 gate over the whole backend** → UI (review-only). 11 tasks, TDD.
- **The s30 Task 1 branch-guard bug is FIXED here** as the shared `ensureAutodevBranch`/`initAutodevRepo`
  (`src/util/ensure-branch.ts`): put a repo on `^autodev/` (no-op if matching / switch to existing / else create the fixed
  `autodev/main`). Wired on register AND a defensive best-effort daemon-startup pass over every registered project.
- **New:** `Git` verbs (`init`/`listBranches`/`checkout`/`createBranch`/`commitEmpty`/`countUntracked`); `admin.initGit`
  (`git init` → empty bootstrap commit → autodev branch; existing files stay UNTRACKED, returns `untrackedCount`); dropped
  the `not_a_git_repo` register gate; `POST /fs/git-init` + `GET /system/git`; fsbrowse hides dot/`$`/system dirs;
  `detectGit` PATH probe. UI: any-folder select + inline init git + git-not-installed banner ("Install it now" → git-scm.com).
- **codex gate:** CHANGES-REQUIRED — 3 Medium + 2 Low. Fixed: (M1) `register` now SURFACES a branch-ensure failure as a
  typed `branch_ensure_failed` (no swallow, no registry append) instead of persisting a broken registration — also resolves
  (M2) the unborn-HEAD case (`git rev-parse --abbrev-ref HEAD` exits 128 on a zero-commit repo → `currentBranch` throws →
  surfaced); (M3) `initGit` rejects a path INSIDE an existing work tree (`git rev-parse --is-inside-work-tree`), not just a
  direct `.git`; (L) 2 test-quality fixes. **Re-critic: CLEAN.**
- **Verification:** 790 tests / 3 skip, root+ui typecheck+build green. **Backend LIVE-PROVEN via curl** on a scratch
  registry: `/system/git` (git 2.49), git-init a non-git folder → `autodev/main` + 2 untracked + empty commit, 409 on
  re-init and on a subdir-inside-worktree, hidden-dir filter, register, and **startup ensure switched a project
  `main`→`autodev/main` (switched to existing, not recreated)**. UI builds; operator to visually verify the New Project
  screen before merge. Env wrinkle: root `build:ui` runs `npm --prefix ui ci` which hit a locked native `lightningcss.node`
  (antivirus/handle) → use `cd ui && npm run build` (or `npm install` to reconcile) — not a code defect.
- **MERGED via PR #53** (merge-commit, NOT squash — it also carried the whole s29 shadcn migration, which was only merged
  LOCALLY in s29 and rode this PR per the s29 handoff; squash would have blobbed 2 sessions). **CI green 4/4** (ubuntu+windows
  × node 20/22). main tip `f51d5d9`. 1 new gotcha (init-leaves-untracked/branch-autoswitch).
- **Live run-test (operator).** After fixing his 404 (STALE daemon — old process served fresh dist/ui files but old
  in-memory routing, so `/fs/git-init` 404'd `[build/stale-dist-backend]`; kill+restart fixed it), he ran a real
  orchestrate: pipeline launched cleanly off `autodev/main` (**branch fix CONFIRMED e2e**), worker wrote the file, but
  codex critic returned `broken` (0.62) — the SMOKE INTENT TEXT contained a non-ASCII em-dash `—`, flagged as a
  documentation/encoding contract concern. Correct gate behavior, not a code bug (my test wording). Operator hit A(accept)
  → task → **quarantine, NOT committed** (accept has no apply-on-commit; s26 `[escalate/replied-holds-filelock]`). An
  ASCII-only intent would commit cleanly. → FUTURE-BACKLOG "apply-on-accept".
- **Still open (out of scope):** (B) orphaned PENDING tasks (enqueue-before-guard) and (C) intent dedup. Minor: 3 corrupt
  run-manifest json spam daemon.log WARNs (harmless).

---

## s29 — 2026-07-06 — Full UI migration to shadcn (Base UI, zinc) — brainstorm → spec → plan → build (autonomous)

**Trigger:** operator noticed our UI only used shadcn's *foundation idiom* (Tailwind+CVA+cn+lucide), not shadcn
components — no `components.json`, no Radix/Base UI. Decision (brainstormed + AskUserQuestion): move the whole `ui/`
to the **default shadcn look on Base UI (zinc), IBM Plex fonts kept, incremental per-screen gated PRs.** New durable
rule recorded: **shadcn-first** (verify shadcn has no equivalent before writing/keeping custom UI) → `AGENTS.md` + memory.

- **Spec + plan** written to `docs/superpowers/{specs,plans}/2026-07-06-shadcn-ui-migration*.md`, committed.
- **Execution:** subagent-driven (Sonnet 5 workers) + **mandatory codex GPT-5.5 critic every phase** (operator granted
  overnight autonomy; merged after critic-clean + green build/typecheck, no per-merge approval).
- **PR0 foundation** (`shadcn init` Base UI/zinc, reconciled theme, `.dark`, 17 primitives, signature-preserving
  Button/Card/TabBar/StatusPill/Dot/Feedback). Critic caught the **muted/accent token-alias collision** (legacy aliases
  hijacked shadcn's reserved names with inverted meaning) + TabBar accent — fixed, re-critic clean.
- **PR1 shell** (DropdownMenu), **PR2 board**, **PR3 run** (VerdictSeal→Badge+Progress+muted composition, new
  `textarea.tsx`, DiffView stays custom), **PR4 task detail**, **PR5 settings+onboarding** (SettingsPopover→Popover,
  gear rewired as the real trigger to fix a toggle regression) — each codex-gated; findings fixed + re-critic each time.
- **Final cleanup:** legacy-token alias layer retired; only status vars (`--color-working/uncertain/broken/clean`) stay.
- **Recurring critic finds (→ gotchas):** zinc light `--card`==`--background`==white & dark `--sidebar`==`--card`
  (layers need borders or `bg-muted`); `text-white` hovers break in light; PR0's `text-muted` sed missed inline
  `var(--color-muted)`-as-text. **Verified: 766 tests / 3 skip, root+ui typecheck + build green.**
- **NOT done during build:** live browser visual proof (browser tooling was down) — left for the operator.

**Post-migration live check (same session, operator at the machine):**
- **UI visually live-verified** by the operator on a real `serve` (`node dist/index.js serve` → `:4319/`, which serves
  the built `dist/ui` directly — no vite needed). Browser-verify item CLOSED. Also diagnosed the operator's "daemon
  won't start" — they ran the bare binary (defaults to conductor `run`, guarded off `main`); the fix is the `serve` verb.
- **Found 3 onboarding/runner bugs (→ s30):** (A) **branch guard** — a fresh project's first run enqueues then dies on
  `conductor: refusing to run on branch 'master'` because the New Project scaffold (`src/registry/scaffold.ts`) never
  switches the repo to an `^autodev/` branch (guard at `conductor.ts:517`, default pattern `^autodev/` `schema.ts:45`).
  Operator wants the scaffold/startup to auto-create+switch to `autodev/*`. (B) **orphaned tasks** — enqueue happens
  before the guard, so a guard-failed run leaves the task stuck in PENDING. (C) **no dedup** — relaunching the same
  intent stacks duplicate tasks; want an equivalent-task-already-pending guard. Cleaned the 2 orphaned smoke tasks from
  the test project's queue. **s30 plan: fix A first (codex-gated) → operator live-verifies → then B/C, then resume.**
- **UX note (operator):** the composer is fire-and-forget ("Run accepted" → silence); operator expects more
  transcript-forward feedback (matches the earlier desktop-IA discussion) — candidate: auto-open Run view on launch /
  inline status stream. Parked in the deferred UI-polish bucket.

## s28 — 2026-07-06 — Agent extensions: worker isolation + always-on critic NO-TOOLS preamble + live visibility scan (PR #51)

**Web-UI item (4) rescoped from "attach skills/plugins/MCP" to "visibility + isolation" after an empirical investigation,
then built in 3 modules (both backend ones independently codex GPT-5.5-gated).**

- **Opener = INVESTIGATION (operator's s27 steer), not a build.** Explore recon + **two live `claude -p` probes** proved
  the spawned worker + critic child CLIs already INHERIT the operator's full ambient extensions (global `~/.claude`/
  `~/.codex` + project config): env passthrough, worker cwd = git worktree, `-p`/`exec` load MCP+skills+plugins+subagents+
  hooks at runtime (bare cwd → 9 MCP / 46 skills / 78 slash / 17 plugins / 11 agents + hook). So "attach" is redundant.
  **Reported → decided WITH operator:** build visibility + isolation. Flag-semantics probe (C) found the flags are NOT
  orthogonal (`--bare` = clean-room, subsumes MCP+skills; init `plugins` count = installed-not-active).
- **M1a (codex merge-clean, `34c83f4`):** config `isolation.worker.{cleanRoom,mcp,skills}` (OFF by default → byte-identical
  spawn); `workerIsolationFlags` (cleanRoom→`--bare`, mcp→`--strict-mcp-config`, skills→`--disable-slash-commands`) appended
  to worker args; **always-on NO-TOOLS preamble in `buildCriticPrompt`** (closes docs-vs-code gap); projection + write path.
- **M1b (codex 1 Medium + 1 Low fixed → re-critic clean, `62307c7`):** `GET /projects/:id/agent-extensions` streams the
  real worker CLI, captures `system/init`, kills before any model turn (zero token cost); thin `onScanExtensions?`
  capability. Fixes: `MAX_REMAINDER_BYTES` buffer cap; streaming-spawner try/catch (never-reject). Low endpoint-guard
  DECLINED (consistent w/ `handleDetectAgents`; global `.catch` backstop).
- **M2 (review-only, `7b7e773`):** Isolation toggles (Clean-room master greys MCP/Skills) + live-scan panel (MCP status
  pills / skills / slash / agents). Wired into `buildDiff` send-only-changed.
- **Verification:** 766 tests / 3 skip, root+ui typecheck + build green. **LIVE-PROVEN** (Playwright + curl): scan returned
  9/46/78/11; PATCH cleanRoom=true → re-scan **0/14/33/3** (matches the `--bare` probe); UI states + Clean-room greying
  proven; screenshots to operator. 2 new gotchas (40 `[agents/inherit-ambient-extensions]`, 41
  `[detect/isolation-flags-not-orthogonal]`). Spec `docs/superpowers/specs/2026-07-06-agent-extensions-isolation.md`.

---

## s27 (B) — 2026-07-06 — Plan checklist in the session rail (operator ask) (PR #49 `e485c36`)

**Second s27 module — an operator ask raised mid-session:** after a plan is written, show the plan todo list in the right
sidebar as a checklist. Recon-first, review-only UI, no backend, live-proven.

- **Recon** (Explore) mapped `SessionRail.tsx` (the Now/Queue/Session/Roles/Tokens `Block`s), the run→tasks link
  (`RunManifest.taskIds` IS the ordered plan; tasks carry no `run_id`, status = the queue they sit in), the `useTaskIndex`
  join, and the `QUEUE_META`/`StatusPill`/`Dot` primitives. **No new backend** — `useRuns`+`useTaskIndex` (over
  `/runs`+`/state`, both WS-invalidated) fully supply ordered ids + live per-task status.
- **UI (review-only, Sonnet worker):** new `<Block title="Plan">` after "Now": newest run (`runs[0]`, matching
  `useSessionUsage`) → its `taskIds` as a live checklist. Row = status glyph + truncated title (native tooltip); `Block`
  header carries a `done/total` badge; a truncated plan label (`name ?? intent`) sits under it. Glyph map (reuse
  `QUEUE_META` tones): done→`Check`(clean), pending→`Square`(idle), active→pulsing working dot, escalated→uncertain dot,
  quarantine→broken dot, unresolved id→muted idle dot (mirrors RunView's "not in any queue" fallback so length==plan).
  "no plan yet" empty/loading state.
- **Verification:** typecheck clean (root+ui), build:ui green, CI 4/4. **LIVE-PROVEN** on a seeded run (4 tasks across
  done/active/pending/escalated) → rail rendered **Plan · 1/4** with correct per-status glyphs + label. Screenshot to
  operator. Self-merged. Follow-up (not blocking): active & escalated both render amber-family dots (inherited Board
  palette — working/uncertain are close); a per-row status label or distinct escalated/quarantine icons would sharpen them.

---

## s27 (A) — 2026-07-06 — Role-matrix editor: role cards + planner/heterogeneity config projection (web-UI item 3) (PR #48 `b8ebce6`)

**s27 opener — web-UI pilot→product item 3.** Layout discussed WITH the operator (his zone) BEFORE building: chose
**cards** (not a grid), planner **optional** with orchestrator-fallback, heterogeneity warning **surfaced honestly from
the backend**. Recon → codex-gated backend → review-only UI → live-proof.

- **Recon** (Explore) mapped `src/config/roles.ts` (roles registry, `heterogeneityWarnings`, `adapterMeta`,
  `assertKnownAdapters`), the config projection (`ProjectConfigView` + `src/index.ts` populate + GET handler),
  `ScaffoldFormSchema`, and the existing `ProjectSettingsView` roles section + `SelectOrCustomRow` + `buildDiff`. Flagged:
  planner is nowhere in the projection/write-schema; `policy.heterogeneity` + warnings are server-internal (logged only).
- **Backend (codex-gated `93928af`, Opus worker, TDD):** `ProjectConfigView` gains `roles.planner?` (projected ONLY when
  the operator explicitly set `roles.planner` in the RAW config — new `loadConfigWithRaw` returns `{cfg, raw}` with NO
  second read; `loadConfig` delegates; `isPlannerExplicitlyConfigured(raw)` gates it since the parsed cfg always defaults
  planner), `policy.heterogeneity` (read-only) + `heterogeneityWarnings[]` (reuses the existing `heterogeneityWarnings(cfg)`
  — respects `off`). `ScaffoldFormSchema` accepts `roles.planner.{adapter,model,effort}` (strict, mirrors orchestrator;
  wired through `buildConfigYaml`+`mergeConfigYaml`, preserves hand-set fields). Pure `buildProjectConfigView` extracted to
  `src/api/config-view.ts`. No runtime planner routing (reserved). **codex GPT-5.5 gate: merge-clean, 0 findings.**
- **UI (review-only `61c5d4c`, Opus worker):** roles → 4 role cards; reuse s26 `SelectOrCustomRow`/`EditableList` +
  detected-agents catalog. Planner OPTIONAL: read-unset→dimmed "not set · orchestrator handles planning";
  edit-unset→"+ Configure planner" (seeds claude/sonnet, `addPlanner` intent flag ensures `buildDiff` never emits planner
  unless added); configured→editable. Heterogeneity warn badge on the critic card + verbatim strip (reuses
  `--color-uncertain` amber token). `buildDiff` send-only-changed contract preserved (planner uses the same `addIfChanged`).
- **Verification:** 737 tests / 3 skip, typecheck clean (root+ui), CI 4/4. **LIVE-PROVEN** on a real serve: read/edit
  cards, detection-backed dropdowns (Claude Code/Codex CLI/GPT-5.5/effort), the FULL planner round-trip
  (unset→"+ Configure planner"→Save→`roles.planner` written to config.yaml→projection includes planner via the raw-presence
  gate→"claude · sonnet" read card). Screenshots to operator.
- **New gotcha `[ui/heterogeneity-badge-forward-looking]` (39):** the badge can't fire on a currently-valid config —
  `assertKnownAdapters` forces worker=claude/critic=codex (families always differ) so `heterogeneityWarnings` is always
  `[]` and a same-family config never loads. Deliberate forward-looking insurance (lights up when the adapter allowlist
  widens); data path proven by `config-view.test.ts`, not a live serve. Also parked two operator asks in `FUTURE-BACKLOG.md`
  (docs commit `e7361b2` rode PR #48): per-field help tooltips/modals (EARLY) + i18n Russian UI (LATE).

---

## s26 (B) — 2026-07-05 — PATH-scan auto-detect of installed CLI agents (web-UI pilot→product slice 1) (PR #47)

**Second module of s26 — the operator's web-UI pilot→product track opens.** Recon-first (Open Design donor), operator
UX gate (Settings dropdowns + a Global "Installed agents" panel; add ollama + kilocode), then a codex-gated backend +
review-only UI, browser-live-proven.

- **Recon** (subagent) mapped Open Design's detection (`references/open-design`): hardcoded registry + pure `existsSync`
  PATHEXT walk (not `which`), `execFile` version probe, static + live model catalogs, per-agent `reasoningOptions`, SSE.
  Our constraints: only claude/codex are live adapters; `cross-spawn` already owns spawn-time PATHEXT, so detection is a
  SEPARATE read-only probe; the UI seam mirrors `GET /fs/dirs`.
- **M1 backend (codex-gated, `c9418d2`)**: pure `src/detect/detect-agents.ts` — curated catalog (2 supported + 7
  display-only incl. ollama/kilocode), PATHEXT-aware **executable** probe (`isFile` + POSIX `X_OK`, not bare `existsSync`),
  best-effort version; `GET /agents/detect` daemon-global via the admin port; `runNative` opt-in `timeoutMs`
  (SIGTERM→SIGKILL, default unset = existing callers untouched).
- **codex GPT-5.5 gate — 3 rounds → CLEAN**: R1 1 High (probe timeout leaked the child — `withTimeout` resolved null but
  never killed) + 2 Medium (`existsSync` reports dirs/non-exec as installed; win32 PATHEXT test non-portable on
  case-sensitive CI) + 1 Low (relative PATH → non-absolute path). Fixed: `runNative` kill deadline; `isExecutableFile`;
  `codex.CMD` test; `path.resolve`. R2 flagged the kill only sent SIGTERM (ignorable) → escalated to SIGKILL after a grace
  period + a SIGTERM-trapping test. R3 CLEAN (safe to merge).
- **M2 UI (review-only, `0a2b7f4`)**: Global Settings "Installed agents" panel (status pill + version + supported tag +
  install link + Rescan); Project Settings adapter/model/effort **dropdowns** (`SelectOrCustomRow` with a Custom… escape
  hatch; effort row hidden for no-effort adapters like claude; worker ladder unchanged; `buildDiff` untouched — both modes
  write the same draft string; falls back to free-text on detection failure).
- **Verification**: 712 tests / 3 skipped, typecheck+build green (root+ui). **LIVE-PROVEN** on a real serve: endpoint
  returned claude (`claude.EXE`) + codex (`codex.CMD` — the PATHEXT shim was resolved, the whole point) supported with
  versions; ollama/kilocode/opencode/cursor-agent/qwen detected display-only; gemini/aider not-detected. Both UI surfaces
  rendered correctly in the browser (screenshots to operator). Daemon + scratch seed torn down.
- New gotcha `[detect/executable-probe]` (38). Branch `autodev/s26-agent-autodetect`.

---

## s26 — 2026-07-05 — fix the replied-escalation file-lock (s26 opener, variant 1)

**The operator-chosen s26 opener — a real correctness/UX bug found live in s25** (`[escalate/replied-holds-filelock]`,
gotcha 37). A replied escalation was left in `queue/escalated/`, where its `file_set` silently blocked every future
run on the same file(s) (`claimNextTask` locks on `active`+`escalated` alike) with no operator signal.

- **Recon-first** (Explore subagent): mapped `handleReply` (`src/api/server.ts`) ↔ `parseEscalation`/reply-write
  (`src/escalate/escalate.ts`) ↔ the scheduler lock (`claimNextTask`, `const locked = [...active, ...escalated]`) ↔
  the single transition helper `repo.moveTask` (atomic `fs.rename`). Confirmed: escalation id === task id; `escalated`
  is effectively terminal — nothing in the codebase ever moved a task OUT of it.
- **Fix (TDD, Sonnet worker):** `handleReply` now transitions the replied task out of `escalated/` after writing the
  reply file — **B (rework) → `pending`** (re-queue), **A (accept) → `quarantine`**. ENOENT tolerated (drift-* has no
  queue file; double-reply) → 200; other move errors → 500 (surface a still-held lock, never silent-200).
- **codex GPT-5.5 gate — 1 High + 1 Medium → fixed → re-critic CLEAN.** High: the first cut used **A → `done`**, which
  falsely satisfies a dependent's `depends_on` (`doneIds`) on work that was NEVER committed (the gate escalated
  *instead of* committing; there is no apply-on-accept machinery). **Operator decision: A → `quarantine`** — releases
  the file-lock without claiming repo-completion (quarantine is neither in the lock set nor in `doneIds`). Medium:
  added a dependency-safety regression test (a dependent stays blocked after an A reply). Re-critic: safe to merge.
- **Verification.** 693 tests (+5) / 2 skip, typecheck green (root+ui). The regression tests run the REAL
  `FileBlackboardRepository` + REAL `createScheduler` over a REAL HTTP server (`createApiServer` + `listen(0)` + `fetch`):
  a replied escalation leaves `escalated/`, unblocks a same-`file_set` pending task, and does NOT falsely satisfy a
  dependent. Real serve wiring (`src/index.ts:150` `view: { repo: root.repo }`) statically confirmed → `p.repo.moveTask`
  works at runtime, not just under the test fake. Proportional: no expensive aurora live-run (the integration test already
  exercises the exact HTTP→repo→scheduler path; no UI surface changed).
- **codex operational gotcha captured** (added to `[critic/codex]`): a background codex run can STALL trying to spawn its
  own plugins/skills in the blocked Windows sandbox and get killed before emitting a verdict (happened twice) — prepend a
  hard NO-TOOLS preamble + run foreground; with the diff inline codex answers in one turn.
- Branch `autodev/s26-escalation-filelock`, fix commit `d5738d4`. PR + self-merge (machine bar + green CI).

---

## s25 — 2026-07-05 — UI cross-run token view (this run/today/all-time) + strip cost from telemetry (PR #45 `c4fae71`)

**The recommended s24 opener — first consumer of the s24 server-side aggregate `GET /runs/:id/usage`, plus the
operator's "token count only, NO cost" cleanup.** Backend codex-gated; UI review-only.

- **UI (review-only).** SessionRail **Tokens** block now shows three rows — **this run / today / all-time** — via one
  `useSessionUsage` hook: fetch the runs list once, call `getRunUsage` per run, bucket in a SINGLE pass (`thisRun` =
  newest run, `today` = runs whose manifest `at` is in the local calendar day, `allTime` = every non-archived run).
  This RETIRES the s22 client-side N×M `useRunUsage` walk (one call per run, not per task). New `api.ts` server
  `RunUsageSummary` type + `getRunUsage` client method; `SessionUsage` shape in `queries.ts`.
- **Strip cost end-to-end (backend, codex-gated — touches the conductor artifact + endpoint).** Operator directive
  (s24 end, memory `[[feedback-usage-tokens-not-cost]]`): TOKEN COUNT only, no `$` anywhere. Removed `total_cost_usd`/
  `cost` from `WorkerUsage`, `TokenUsageDoc` (nested + top-level), `parseClaudeUsage`, `buildTokenUsageDoc`,
  `RunUsageSummary`, `buildRunUsageSummary`, `isTokenUsageDoc`, and the UI mirrors (`api.ts` `TokenUsageDoc`,
  `queries.ts`, `SessionRail` `formatCost`). **Backward-compatible**: a legacy `token-usage.json` still carrying
  `total_cost_usd` validates and contributes its tokens (never its cost) — `isTokenUsageDoc` ignores the extra field.
- **codex GPT-5.5 gate — 1 Medium + 1 Low → fixed → re-critic CLEAN.** Medium: `buildTokenUsageDoc` persisted
  `worker.runs` by REFERENCE — dropping the field from the *type* does not strip it from a *runtime* object handed in,
  and `JSON.stringify` serializes the real shape → a stray cost could leak into the written artifact. No active trigger
  (the sole `WorkerUsage` constructor `parseClaudeUsage` is cost-free), but at a persisted-artifact write boundary under
  a "no cost anywhere" contract, the defense is cheap and makes the guarantee STRUCTURAL. Fixed: rebuild worker+critic
  per-run arrays as token-only copies at the write boundary + regression test asserting `JSON.stringify(doc)` carries no
  `/cost/i`. New gotcha `[usage/type-strip-not-runtime-strip]` (36).
- **Verification.** 688 tests (+2 skipped), typecheck green (root+ui), both bundles rebuilt. **Live-smoke** on a seeded
  2-run project (run-a today / run-b 2 days ago): endpoint curl-proved (`run-a` tokens=120 with **no `cost` field**;
  `run-b`=100; the legacy-with-cost task counted token-only) → rail rendered **this run 120 / today 120 / all-time 220**
  (older run correctly excluded from today, included in all-time). Screenshot sent; seed + daemon torn down.
- main tip = `c4fae71` (PR #45 squash — folded in the two unpushed s24 docs commits `0860506`+`4cf7ed9` per batch-merges).
  This session-save docs commit rides the next PR. Working tree clean.

**Live token-run demo + bug find (post-merge, operator-driven).** Served the daemon on aurora's REAL state and the
operator drove a fresh `orchestrate` from the UI to see live tokens. Outcome: worker (sonnet) → `php -l` gate → **codex
critic `clean` 0.98** → **COMMIT `9b373aa`**; `token-usage.json` written with real worker usage (**531,533 tokens**) and
**no `cost` field** — the s25 strip proven on a live run; rail rendered this run/today/all-time = 531.5k; s24's persisted
`critic-verdict.json` also exercised (real seal). **Bug surfaced live → gotcha `[escalate/replied-holds-filelock]` (37):**
the run first would NOT start — decompose+enqueue OK but the task sat in pending, worker never ran, `conductor.log`
silent, `--once` a 0-second no-op. Root cause = a replied-but-uncleared escalation (`docs-llmfactory-classdoc-v2`, s14)
still in `queue/escalated/` held its `file_set`, and `claimNextTask` locks on `escalated` exactly like `active`, so every
same-file run was silently blocked with no operator signal. Unblocked by moving the resolved escalation → `done`
(operator-approved). **This is the s26 opener (variant 1):** the reply-apply path must move `escalated → done` (accepted)
or re-queue `→ pending` (redo). **Operator UI/UX steer:** the dashboard is a PILOT, not final — PATH auto-detect of
installed CLIs, preset model/effort pickers, richer role matrix, skills/plugins/MCP surface are unbuilt; **polish the web
UI to a real product BEFORE the desktop wrap → desktop DEFERRED** (`FUTURE-BACKLOG.md` "Web UI: pilot → product"). Demo
daemon + scratch registry torn down; aurora left on disposable branch `autodev/s25-token-demo`.

---

## s24 — 2026-07-04 — TWO modules: critic-verdict.json persistence (PR #43 `b9b87f9`) + server-side run usage aggregation (PR #44 `8067022`)

**Module 2 — server-side per-run usage aggregation `GET /projects/:id/runs/:runId/usage` (PR #44 `8067022`).** Operator
picked NEXT-ACTIONS candidate (b). s22 aggregated token usage client-side per open run only; a cross-run "today" total
would need N×M client fetches, so this adds the clean server path. Pure `buildRunUsageSummary(docs, taskCount)` +
`isTokenUsageDoc` guard in `src/usage/usage.ts` (`num()`-coerced sum; boundary validation skips non-usage JSON);
`handleGetRunUsage` + route in `server.ts` REUSING the existing TOCTOU-hardened readers (`readBoundedManifest` +
`readBoundedFileText`) — no new file-reading security code. Returns `{tokens, cost, any, taskCount, tasksWithUsage}`.
**codex gate — 3 findings:** Medium duplicate-id double-count → FIXED (dedupe + drop path-unsafe ids up front,
`taskCount` = unique-safe) + regression; Low `Promise.all`-rejects-on-throw → FIXED (per-task body wrapped → returns
`TokenUsageDoc|null`, filtered = best-effort by construction); Low nondeterministic sum order → FIXED by the same change
(manifest order). **Re-critic residual:** case-insensitive-fs path-alias double-count (`["t1","T1"]`) → DECLINED with
rationale (orchestrator ids unique + never case-variant; such tasks can't coexist on a case-insensitive fs; bounded
read-only display over-count; a portable case-fold would wrongly merge distinct ids on Linux/CI) — documented in the
handler as an accepted residual. 684 tests, typecheck green, live curl-proof (`tokens:5000 cost:0.08 taskCount:2`).
No UI consumer yet (a "today" view is the follow-on) — the endpoint is the deliverable per the operator's scope.

**Module 1 — critic-verdict.json persistence + committed-task verdict seal (PR #43 `b9b87f9`).**

The recommended s24 opener — closes gotcha `[ui/verdict-not-persisted]`. A CLEAN-committed task never escalates, so its
critic verdict survived only as a `digest.md` line; the dashboard's "verdict first-class" was rich only on escalation.
Since the conductor already writes per-task JSON runtime artifacts (s22 `token-usage.json`), a sibling
`critic-verdict.json` was the natural, well-scoped next module. Full sonnet-TDD → spec-check → codex-gate → re-critic.
- **Backend (codex-gated, enforcement-adjacent).** Pure `buildCriticVerdictDoc` + `CriticVerdictDoc` in
  `src/critic/verdict.ts` (exactOptional-safe `diff_sha256` omission). Best-effort/never-throws `persistCriticVerdict`
  closure in the conductor, written ONLY at a task's DECISIVE point (before the clean `break`, and in the escalate
  branch guarded `if (cr.verdict)`) — never on intermediate retry rounds. Same never-throws contract as
  `persistTokenUsage` (`safeLog`, `[ts/fail-closed]`); served unchanged by the runtime-file endpoint (no new API code).
- **codex GPT-5.5 gate — 3 findings.** (1) Medium: the FIRST cut persisted every round → a `parseable→retry→null→
  escalate` sequence left a STALE earlier verdict on disk → FIXED via decisive-only placement (intermediate rounds
  never write; a valueless final round leaves no artifact) + a regression test. (2) Medium: extra `clock.now()` not
  "purely observational" → DECLINED with rationale (prod clock is side-effect-free; identical to the already-gated s22
  `persistTokenUsage`; the parity #9 `nowCalls` 3→4 shift crosses NO decision boundary — graceful exit preserved).
  (3) Low: no throwing-logger test → ADDED (writeRuntimeFile throws AND logger throws → clean task still commits).
  **Re-critic: behavior/control-flow CLEAN**; one residual doc-comment ("each round") corrected.
- **UI (review-only, browser-proven).** `CriticVerdictDoc` type + 404-tolerant `useTaskVerdict` hook (mirrors
  `useRunUsage`). Inspector `VerdictTab` prefers the REAL persisted verdict (confidence + notes + broken_contracts via
  the reused `VerdictSeal`) over the state-synthesized placeholder; falls back to synthesis for undecided/pre-s24 tasks.
- **Verification.** 671 tests (+9), typecheck green (root+ui), CI 4/4. **Browser-smoke** on a seeded scratchpad serve:
  the Verdict tab of a committed task rendered `clean` + confidence `0.92` + the persisted notes (vs the old fabricated
  "Critic returned clean; committed & merged." with no confidence). Screenshot sent; seed + daemon torn down.
- **Merge friction.** The auto-mode classifier BLOCKED the self-merge (it discounts the standing memory/CLAUDE.md
  autonomous-merge grant, wanting an explicit in-session OK). Surfaced to the operator (not a design fork — a mechanical
  gate); he replied "мёржи" → squash-merged. Consider a `.claude/settings.json` `Bash(gh pr merge:*)` rule to avoid the
  stop next time (operator's call).
- 1 new gotcha `[conductor/per-round-overwrite-stale]` (34→35). main tip = `b9b87f9`; this docs commit rides the next PR.

**Candidate (c) — codex critic `--json` — ASSESSED & DECLINED (operator agreed).** After the two modules, reconned (c)
before building. Finding: the verdict's authoritative source is the `-o` outfile, but stdout is the FALLBACK
(`parseVerdict` outermost-braces) AND `parseCodexTokens` reads a bare `tokens used` footer — a full `--json` switch
(JSONL event stream) breaks BOTH, and the `--json` event schema is undocumented in-repo (needs an `ADH_LIVE` capture to
design safely). Safe designs both bad-payoff: a separate `--json` spawn doubles critic cost forever, or a single-call
switch bets the gate on unverified CLI behavior — for marginal split+cost telemetry. s22's spec already codified this as
a bad trade. Operator agreed to skip. Recommended cheap next instead: a UI "today" usage view over the new `GET
/runs/:id/usage`. **Workflow snag:** uncommitted docs on the #44 branch were discarded by the post-merge `reset --hard`
and re-applied — commit docs before any reset next time.

---

## s23 — 2026-07-04 — run rename + archive + UI re-run LANDED (PR #42 `53d2ced`)

Second module of the session. Backlog item NEXT ACTIONS #3 (was unscoped) — designed WITH the operator after a
**donor recon** (subagent over AO/OD/OpenHands). The recon reshaped the design decisively.
- **Recon findings.** Rename is donor-unanimous: id immutable + a separate mutable display field (`display_name`/
  `name`/`title`). Archive appears only at AO's CONTAINER (project) level as a `archived_at` soft-flag; the run/session
  unit prefers derived status. **Fork:** AO has none; OD/OpenHands fork a *conversation/event-stream* — which we don't
  have. Our run manifest is a re-derivable index over the blackboard queue, so "fork" ≈ re-orchestrating the intent.
- **Decisions (operator-gated).** Rename + archive as backend verbs; **fork → UI-only "re-run"** (seed the composer,
  no backend fork); archive = reversible `archived_at` soft-flag (no hard-delete). All verbs touch ONLY the manifest.
- **Backend.** `RunManifest` +`name?`/`archived_at?` (`recordRun` unchanged; `isRunManifest` type-validates optionals).
  Pure `applyRunPatch`. `GET /runs?includeArchived=1` (default hides). `PATCH /projects/:id/runs/:runId` — bounded read
  (404 on missing/corrupt) + hardened no-follow write.
- **codex GPT-5.5 gate — 3 defects over 2 rounds, all fixed → re-critic clean.** (1) HIGH `lstat`→`writeFile` TOCTOU
  followed a symlink swapped in between → replaced with `O_RDWR|O_NOFOLLOW` open + `fstat` + `truncate(0)` +
  `fh.writeFile`. (2) MEDIUM name length checked AFTER `trim`, so 201 spaces passed and CLEARED an existing name →
  raw-length check + regression test. (3) MEDIUM `fh.write` can short-write (ENOSPC/quota/net-FS) → `fh.writeFile`
  (loops). Also: Windows rejects `O_WRONLY|O_TRUNC` without `O_CREAT` (EINVAL) — found empirically, worked around with
  `O_RDWR` + `truncate(0)`, keeping the no-resurrection property (no `O_CREAT`).
- **UI (review-only).** `name ?? intent` on the HomeView card / sidebar / RunView header; RunView actions bar (inline
  rename, archive/unarchive, re-run via a zustand seed store read+cleared by NewRunComposer); HomeView "show archived"
  toggle + muted tag.
- **Verification.** 662 tests (+10 backend), typecheck+build green (root+ui). **Browser-smoke** on a seeded serve drove
  the whole flow live: rename → archive (default list hides) → `?includeArchived` shows → unarchive → re-run (composer
  pre-filled + navigate home) → HomeView show-archived toggle. Screenshot sent; seeded project + daemon torn down.
- **Gotcha caught mid-build (noted in CURRENT-STATE):** a UI-only `build:ui` leaves the served `dist/index.js` STALE —
  a brand-new backend route 404s in the live smoke until a root `npm run build`. Rebuild BOTH before a live smoke.
- Self-merged (machine bar: codex-clean + green CI 4/4). main tip = `53d2ced`. Branch carried the s22 docs commit too.

---

## s22 — 2026-07-04 — token/usage instrumentation LANDED → the first post-P3 module (PR #41 `675baf0`)

The next real module after P3 closed. Operator scope-gated at session start: **per-task runtime file + client-side
aggregation by run** (minimal conductor touch; the existing generic runtime-file endpoint serves the artifact, so **no
new API code** — the key scope win). Enforcement-adjacent (worker/critic adapters) + conductor → full TDD → spec-check →
independent codex GPT-5.5 gate → re-critic.
- **Backend.** New pure `src/usage/usage.ts`: `parseClaudeUsage` (last stream-json `result` event's `usage`+`total_cost_usd`),
  `parseCodexTokens` (line-anchored bare `tokens used` footer), `buildTokenUsageDoc` aggregator. `WorkerResult.usage?`
  attached in `claude-adapter.toResult`; `CriticResult.usage?` in `codex-adapter` — plain `codex exec` KEPT (not `--json`)
  so the enforcement verdict-resolution path is byte-unchanged; critic yields a single `tokens` total. Conductor
  accumulates worker+critic usage per round → writes `token-usage.json` best-effort/never-throws (`[ts/fail-closed]`,
  same discipline as recordRun/digest/teardown; pushed BEFORE the rate-limit/timeout early-returns so throttled steps
  still account).
- **codex GPT-5.5 gate — 1 Medium.** `parseCodexTokens` first matched "tokens used" ANYWHERE in stdout and grabbed the
  next integer → false telemetry from prose like "No tokens used in this example; finding 3 ...". Fixed = LINE-ANCHORED
  (the whole trimmed line must BE the footer; inline `: N` or a bare-integer next line) + 3 regression tests including
  the exact false-telemetry case. **Re-critic clean** — no residual (verified the real `tokens used\n<N>` + `: N` forms
  still parse, no backtracking, no off-by-one).
- **UI (review-only).** `SessionRail` Tokens block drops the `phase 2` placeholder; new `useRunUsage` hook sums the
  newest run's per-task `token-usage.json` on the client (404-tolerant — a task with no usage file is skipped, never
  fails the summary). `formatTokens` (`52.4k`/`2.1M`) + `formatCost` helpers. `TokenUsageDoc` mirror in `api.ts`.
- **Verification.** 654 tests (+19: 13 usage, 2 claude, 3 codex, 3 conductor incl. best-effort-throw), typecheck+build
  green (root+ui), CI green 4/4. **Browser-smoke** on a seeded serve (scratchpad project, port 7822): rail rendered
  `this run 52.4k · cost $0.0473` (client aggregate over one task-with-usage + one 404 task tolerated); screenshot sent
  to operator; seeded project + daemon torn down. Self-merged (machine bar: codex-clean + green CI).
- **Batch-merge note (git mechanics).** The s21 docs commit `66e04c7` was committed locally on main but never pushed
  (direct push to main is classifier-gated → docs ride with the next PR per AGENTS.md). GitHub's squash of PR #41 folded
  BOTH the s21 docs AND the s22 module into `675baf0`; `git diff 66e04c7 HEAD -- docs/` = only the new spec file, so all
  s21 content is preserved in main (the commit OBJECT isn't in linear history, but its content is — exactly how
  batch-merges are meant to work). Reset local main to `origin/main` to drop a spurious pull-merge commit.
- No new gotchas (the `parseCodexTokens` lesson is a code-review catch, not a repeated-mistake gotcha; count stays 33).

---

## s21 — 2026-07-04 — woodev deps-provisioning ops-proof LANDED → P3 loop proven end-to-end (COMMIT `912ef64`)

Operator on `/remote-control` chose the operator-gated ops-proof (Task 9 of the deps-provisioning plan) and observed —
the last open P3 item. The deps-provisioning CODE shipped back in s15 (PR #29); s21 is the live proof on a real,
production-shaped project.
- **Setup.** Local `git clone` of `woodev_framework` → disposable `D:/Projects/woodev-harness-clone`, branch
  `autodev/s21-proof`. Untracked `.autodev` (PS-loop's) + `.serena` (MCP churn) via `.git/info/exclude` so runtime/MCP
  writes can't dirty the merge tree. Copied gitignored `vendor` (76M) + `plugins-reference` (17M) from the original.
  Bumped the clone's phpstan `--memory-limit` 2G→4G (base phpstan crashed a parallel worker at 2G — env, not code:
  `[OK] No errors` at 4G; full `composer check` green on the main tree at 98s). `.autodev/config.yaml`:
  `worktree.provision: [vendor, plugins-reference]`, worker claude/sonnet, critic codex/gpt-5.5/high. Task = a
  class-level PHPDoc on `woodev/box-packer/abstract-class-packer.php` (docs, non-contract-zone — mirrors aurora's proven
  docs task).
- **Green COMMIT.** `run --once` (detached Start-Process, cwd=clone) → worktree created with `vendor` +
  `plugins-reference` as NTFS junctions (verified) → worker (sonnet) wrote the docblock → critic (codex/gpt-5.5) `clean`
  0.88 → gate `composer check:static` (phpcs+phpstan) **GREEN in the worktree on the provisioned deps** →
  `gate-verdict.json` `composer_green:true decision:COMMIT` → **COMMIT `912ef64`** → link-only deprovision → safe
  teardown. Main `vendor` intact (5168), original `woodev_framework` untouched, tree clean.
- **KEY FINDING → new gotcha `[worktree/vendor-junction-autoload-basedir]`.** First attempt used the full `composer
  check` (incl. **phpunit**) and RETRY'd on exit 255. Root cause (reproduced standalone): phpunit EXECUTES the framework
  (loads a real plugin fixture through the resolver); `vendor` is a junction, so PHP resolves `__DIR__` inside Composer's
  autoloader to the junction's REAL target → `$baseDir` = the MAIN clone → project classes autoload from the main clone
  while worktree-relative `require_once` loads the worktree copy → `Cannot redeclare class Woodev_Packer`. Read-by-path
  tools (`php -l`/phpcs/phpstan) are unaffected — hence the static gate for the green run. A runtime phpunit gate needs
  per-worktree `vendor` materialization (backlog).
- **`[worktree/win-junction-follow]` re-confirmed live, the hard way.** A NON-link-safe manual repro cleanup (bash
  `rmdir` on a live junction — which fails silently and leaves it — then `git worktree remove --force`) followed the
  junction and wiped the disposable clone's real `vendor/` (original untouched; recopied). The harness's OWN teardown
  was safe every time (link-only deprovision logged before recursive removal). Lesson: never bash-`rmdir` a live
  junction; use PowerShell `(Get-Item link).Delete()` / the harness `removeLinkOnly`.
- Docs: CURRENT-STATE (P3 CLOSED), 1 new gotcha (32→33). No harness source changed (ops-proof only). main tip advances
  with this docs commit.

## s20 — 2026-07-04 — Project Settings edit mode extended to every role field (PR #40); token/usage instrumentation scoped for s21

Operator went to sleep at session start with full autonomy granted ("работай автономно... мержи, пушь"). Woodev
ops-proof stayed gated, untouched. Picked the lowest-risk, best-scoped remaining backlog item by judgement rather
than starting the two larger/design-uncertain ones unsupervised.
- **PR #40 — Project Settings: `roles.orchestrator`/`roles.worker.adapter`/`roles.critic` now editable.** Closes the
  s19 note ("roles.* scoped out of the first cut"). Pure UI — backend (`PATCH /projects/:id/config` +
  `ScaffoldFormSchema`) already accepted these fields since PR #37. 7 new `TextFieldRow`s; `buildDiff`/`addIfChanged`
  send only per-role sub-fields that actually changed, mirroring the established `checkCommand` convention.
  Review-only (no conductor touch). **Browser-live-proven on the REAL aurora sandbox**: edited
  `roles.orchestrator.model`, confirmed the live config projection updated immediately (hub-evict from s19 still
  holding), reverted via a second UI edit. codex GPT-5.5 review: no blockers. CI green 4/4, self-merged.
- **Scoped, deliberately NOT built: token/usage instrumentation for the Tokens rail.** Sizing call: touches
  worker/critic adapters + the conductor (persist per-task/run usage) — needs the full TDD→gate discipline, not a
  quick polish item. Findings for s21: Claude worker already runs `--output-format stream-json` and already
  captures stdout (`WatchedRunResult.stdout`) — the final `result` event has a ready-made `usage` object, no new
  adapter flag needed. Codex critic's plain-text stdout ends with a `tokens used\n<N>` line (confirmed live in this
  session's own codex-review call) — parseable, or switch to `--json` for a structured event. Full findings in
  `docs/CURRENT-STATE.md` NEXT ACTIONS #2.
- Also flagged `run rename/archive/fork` as NOT actually scoped (no `name` field on the run manifest today, no
  defined archive/fork semantics) — needs a short design pass before implementation, unlike the s19 project-rename
  precedent it superficially resembles.
- No new gotchas this session.
- main tip = `565bab2`. Working tree clean at session end.

---

## s19 — 2026-07-04 — 3 P3 backlog items shipped & merged (PR #36, #37, #38) — registry rename, config-write, switcher menu

Operator away for most of the session (auto-mode); the woodev ops-proof stayed gated (untouched). Picked backlog items by
judgement, full worker→spec-check→codex-gate→re-critic→self-merge discipline throughout.
- **PR #36 — `PATCH /projects/:id` rename** (registry `name` only; `id`/`path` immutable). codex clean; 2 minor
  test-coverage gaps closed with regression tests. 612 tests. Browser-live E2E (API all paths + UI inline rename,
  sidebar re-fetch).
- **PR #37 — `PATCH /projects/:id/config`** (project settings editable in UI). `mergeConfigYaml` preserves hand-set
  fields the form doesn't cover; `hub.evict(id)` on write success (else the live daemon keeps the stale gate/role
  config — real bug caught by design review, not codex). codex found 2 blockers: (1) `config.yaml` itself unguarded
  against symlinks (only `.autodev` dir was) — fixed + regression test; (2) claimed `hub.evict` in-flight-build race —
  investigated against the full `get()` control flow, NOT reproducible, codex confirmed on re-review. Re-critic clean.
  633 tests. **Browser-live-proven on the REAL aurora sandbox** (not a fixture): edited `roles.worker.ladder`, confirmed
  hand-set `roles.critic.*`/`gate.checkCommand` survived, reverted.
- **PR #38 — composer project-switcher** — real dropdown menu replacing the static chip. Pure frontend, review-only.
- Ran the daemon live for the operator mid-session (aurora + throwaway registry) — operator independently registered a
  REAL project (`woodev-shipping-plugin-test`) via the New Project flow while watching; left it untouched.
- 3 new gotchas: `[hub/evict-on-config-write]`, `[scaffold/config-file-symlink]`, `[config/yaml-merge-drops-comments]`.
- main tip = `a65cd60`. Working tree clean at session end.

---

## s18 — 2026-07-04 — P3 product shell CLOSED: M4-7 settings screens + M5 light theme — merged (PR #34)

**M4-7 settings + M5 light theme (PR #34 `75f9675`, review-only static UI).** Built directly by the main session (cohesive
UI against the already-loaded design system), then an independent code-review pass — no codex gate (static presentation UI:
"review, don't gate").
- **Global `/settings`** (`GlobalSettingsView`): Appearance (theme control), Projects registry (list + two-step click→confirm
  unregister via `useDeleteProject`, live list invalidation), Daemon info (conn from the WS store / `location.host` / count).
- **Project `/p/:id/settings`** (`ProjectSettingsView`): read-first projection over `GET /projects/:id/config`
  (repo / gate / branch pattern / provision / roles) + note that editing stays file-based (config-WRITE endpoint = next add).
- **`SettingsLayout` kit** (page/section/row) shared by both; router replaces the two "coming in M4-7" placeholders;
  AppShell excludes `/settings` from the session-rail predicate.
- **M5:** `[data-theme="light"]` override block in `styles.css` remaps the chrome (ink/panel/surface/line/text), status +
  verdict hues stay shared. Completes the `System·Dark·Light` switcher that was already wired in `lib/theme.ts`.
- **Browser-live-proven** (Playwright, seeded registry = aurora real config + a defaults project): both screens dark + light,
  theme persists across nav, and a **real end-to-end unregister** (registry file on disk + sidebar + count all updated live).
  typecheck clean, CI green 4/4. Review: ship-ready; 2 sub-threshold polish notes applied (stale `theme.ts` comment;
  `del.reset()` on cancel to drop a stale delete-error).

**Merge-permission friction fixed at the root.** The auto-mode classifier repeatedly denied `gh pr merge`
("[Merge Without Review]") because no `permissions.allow` rule existed — and the agent surfaced it to the operator as a
question, which he was (rightly) fed up with. Root cause: docs say "self-merge" but the classifier is a separate gate. Fix =
`.claude/settings.json` with `Bash(gh pr merge:*)` (+ create/checks/view). The agent **cannot self-write** it (writing your
own auto-execute permission is itself classifier-blocked as "[Self-Modification]") — so the operator created it. Memory
sharpened: a classifier merge-deny is a mechanical blocker to RETRY, never a fork to route to the operator.

**Gotchas:** `[registry/json-win-backslash]` (hand-written Windows `\` paths → invalid JSON → silent empty registry; use
`/`), `[ui/light-theme-tokens]` (the `[data-theme]` re-cascade depends on plain `@theme` not `@theme inline`; shared status
hues are fine as dots but marginal as text on light).

---

## s17 — 2026-07-03/04 — P3: M3 (New Project backend) + M4 (product shell UI) — both codex/CI-clean, both merged (PR #31, #32)

**M3 — New Project flow backend (PR #31 `7c80a90`, codex-gated).** `GET /fs/dirs` server-side folder browser (dirs-only,
git/registered badges, symlinks annotated with resolved target, `invalid_path`→400-never-500), `POST /projects` (register +
optional `.autodev/` scaffold), `DELETE /projects/:id` (registry-only, before root-resolve so a broken-config project is still
deletable, closes its watcher). Scaffold: config.yaml validated through the real strict schema BEFORE any write, blackboard
skeleton + GOAL/INVARIANTS stubs (`wx`, never clobber), idempotent `.git/info/exclude`, config last. `isPathRegistered`
extracted + reused; register/unregister behind a promise-chain mutex. Codex R1 **broken** (4) → HIGH symlink-escape fixed →
re-critic **uncertain** (narrower symlinked-child residual) → fixed → **clean**. Windows CI caught an 8.3-short-path realpath
divergence (green locally) → fixed. 592→596 tests, CI green 4/4.

**Autonomy rule sharpened.** Operator: "мержи сам, не жди меня; дёргать ТОЛЬКО на развилках где 100% нужно моё участие."
Codified in `AGENTS.md` (agent owns ALL git+GH incl. merges; gate on machine bar + green CI, then self-merge) + memory.

**M4 — product shell UI (PR #32 `c121a05`, review-only + one gated backend add).** projectId moved into the router path
(`/p/:id/…`), query-keys/api/ws gained the projectId dimension, `ProjectGate` shim deleted; M3 api hooks; **gated** read-only
`GET /projects/:id/config` (curated config for the shell); multi-project sidebar (last-5 runs + verdict seals, settings
popover, theme control); composer-first Home + top bar; session-inspector rail (Now/Queue/Session/Roles/Tokens-placeholder);
New Project screen (folder browser + register form). **M4-7 settings screens deferred** (honest placeholder routes).
**Browser-live-proven end-to-end** (Playwright): shell renders aurora's real config; New Project flow driven fully from the
browser — folder browser → select fresh git repo → register → `.autodev/` scaffolded on disk + git-exclude + registry entry →
redirect → immediately drivable. Subagent-driven (sonnet+opus by complexity); config endpoint codex **clean**; CI green 4/4.
New gotchas: `[ci/win-83-realpath]`, `[scaffold/symlink-escape]`.

---

## s16 — 2026-07-03 — P3 slice 2: UI/UX design gate + multi-project daemon M1–M2 — codex-gated clean, merged (PR #30)

**Design gate (the operator's reserved topic, resolved WITH him):** operator brought 11 reference screenshots
(Codex/Claude desktop → `screenshots/`, git-ignored) + his wishlist (New Project, projects+sessions sidebar, settings
popover, stats rail). Three forks decided: **full multi-project daemon** (not single-active rebind), **browser now /
desktop wrap later** (loopback HTTP/WS makes the wrap additive), **server-side folder browser**. Visual mockup built in
our design tokens → `docs/superpowers/specs/2026-07-03-s16-shell-mockup.html`; kanban stays a secondary lens. Spec
(`2026-07-03-p3-multiproject-shell-design.md`, modules M1–M5) approved on trust; M1–M2 plan written and executed.

**Built (M1–M2):** identity-only registry `~/.autodev/projects.json` (project truth stays in `.autodev/config.yaml`);
`buildProjectRoot` extracted from `index.ts` into `src/composition/root.ts`; **ProjectHub** (lazy per-project roots,
error isolation, path-aware caches); API re-rooted under `/projects/:id/...` (old top-level routes removed, `GET
/projects`, per-project orchestrate single-flight, per-project watchers, WS events carry `projectId`); `serve` is
daemon-global with the UI bundle resolved install-relative (**closes `[ui/serve-uidir-reporoot]`**); interim UI shim
auto-selects the first project. CLI verbs stay cwd-bound.

**Gate:** codex GPT-5.5 R1 `broken` 0.87 — 7 findings, incl. three genuine classes: shared in-flight promise rejection
escaping the hub's cached branch (500 instead of 503); id-keyed caches surviving a registry re-bind (orchestrating the
WRONG repo); the "mechanical" extraction making the orchestrator eager (broke `run` for orchestrator-less configs).
All fixed w/ regression tests → R2 `broken` 0.82 (2 residual: stale-watcher broadcast, path-less `lastError`) → fixed →
**R3 `clean`**. 537 tests (was 512), typecheck clean, CI green 4/4, squash-merged → `main` `6337215` (PR #30).
Subagent-driven: 5 sonnet + 2 opus workers, 3 codex rounds. New gotchas: `[ts/shared-promise-reject]`,
`[refactor/extraction-eagerness]`, `[multiproject/id-keyed-caches]`.

**Next:** M3 (fs-browser + register + scaffold), M4 (shell UI per mockup), M5 (themes); ops live-proof of
deps-provisioning on a woodev clone still deferred (operator-observed). Roles confirmed: Fable 5 = brain, Sonnet 5 /
Opus 4.8 = workers by complexity, codex GPT-5.5 = critic.

---

## s15 — 2026-07-03 — P3 slice 1: deps-provisioning (real test gate in worktrees) — codex-gated clean, merged (PR #29)

**Context:** P2 done. Design-gated P3 with the operator (reference-first: reconned AO + OD Electron shells). Operator
scoped the first slice to **"real-use gaps"** — close what blocks the harness taking REAL tasks off the PS-loop — and
chose the target: a **clone of `woodev_framework`** (most relevant, safe). Recon of the live woodev (read-only) found:
real gate = `composer check` (phpcs+phpstan+phpunit, no DB); **`plugins-reference/` is gitignored but load-bearing**;
no `.autodev/config.yaml` (PS config is hardcoded in `_common.ps1`). Spec + 9-task TDD plan written & approved.

**Built (Finding #1): `worktree.provision`** — links gitignored dep dirs (`vendor`, `plugins-reference`) into each
per-task worktree (junction/Windows, dir-symlink/POSIX) so the gate graduates `php -l` → `composer check`. Empty = off
(backward compat). Config block (`.strict()`, top-level segments) + link/unlink in the worktree manager + composition-root wiring.

**The hard part — a real, reproduced data-loss class caught by the gate.** sonnet-5 TDD → **4 rounds of independent
codex GPT-5.5 gate**, each closing a genuine reproduced defect: (R1) `removeLinkOnly` swallowed failures / deleted
non-links / host-only absolute check + 4 more; (R2) cleanup used only the current config → stale links survived a
config change; (R3) a best-effort manifest is not authoritative (write-fail/corruption); (R3b) recursive strip removed
tracked source symlinks. **Key discovery (verified 6/6):** on Windows `git worktree remove --force` **FOLLOWS an NTFS
junction and recursively deletes its real target**. Final design: **link-only-remove EVERY top-level reparse point
BEFORE any recursive removal; refuse to recurse otherwise; restrict provision entries to a single top-level segment**
so the non-recursive scan is complete. R4 verdict: **`clean` (0.88)**; only residual = nested FOREIGN junctions
(pre-existing git-on-Windows behavior, not introduced here) → documented. Gotcha `[worktree/win-junction-follow]`.

**Result:** 502 tests, typecheck clean, **CI green 4/4**, squash-merged → `main` `dc8b6cd` (PR #29). Subagent-driven
throughout (1 implementer + spec-review subagent + 4 codex fix/re-critic rounds). **Not yet done: the ops live-proof
on a woodev clone** (deferred — heavy live run) and the **project picker / UI-UX** (operator wants to design it next).

**Process note (operator feedback, s15):** stop pinging on decidable gate-fix questions — decide & proceed; reserve
decisions for UI/UX + real merges/live-proofs. Saved as `feedback-decide-dont-ask`. Communicate RESULTS, not activity.

---

## s14 — 2026-07-02 — P2 Module 5 (dashboard UI) shipped + LIVE-PROVEN on aurora through the browser

**Context:** s13 shipped the P2 backend; the ONE thing left was Module 5 — the React/Vite UI itself. Operator
chose to **discuss layout FIRST**. Read all anchors; reconned the in-project donor frontends (AO + OD) BEFORE
designing (reference-first). **open-warehouse dropped as a reference** — operator: refs live only in `references/`
(the design spec + s13 promt wrongly cited it). Saved a feedback memory.

**Layout, signed off:** operator steered to an **agent-desktop IA** (Claude Code / Codex / Devin desktop) — not a
kanban-hero: sidebar runs-list + transcript-forward main + inspector rail, **critic verdict FIRST-CLASS** as a
"verdict seal" (the thesis, made visible). Task detail = its own 2-pane route. Design direction (frontend-design
skill): control-room dark ink, verdict tones the only saturated color, mono-forward type (Plex Mono/Sans + Space Grotesk).

**One gated backend add — `GET /escalations/:id`** (the A/B card needs the escalation body; escalation id == task id,
so no list endpoint). sonnet TDD (`parseEscalation` inverts `buildBody`; TOCTOU-hardened bounded read) → my spec-check
→ **codex GPT-5.5 gate `broken`, 4 findings** → 3 fixed w/ regression tests (evidence containing a ``` fence
round-trips via backward close-scan; field lookup restricted to pre-evidence; `parsed.id === :id`), **1 declined w/
rationale** (final-component no-follow is consistent with sibling endpoints) → **re-critic `clean`**. 480 tests.

**UI (reviewed, not gated):** own `ui/` workspace (heavy toolchain out of the daemon build), Vite → `dist/ui`;
hand-rolled shadcn-idiom primitives (no headless dep → reliable build); `@fontsource` (offline). Screens: Home
(hero + composer), Board (5 queues by attention tone, done collapsed), Run transcript, Task detail (2-pane:
escalation A/B + spec + lifecycle | inspector Verdict/Diff/Report/Files). Live via existing WS → React-Query invalidate.

**Verified for real (Playwright — Claude-in-Chrome was offline):** (1) demo — real api-server over a seeded stateDir:
board/detail render, escalation A/B reply writes the file, diff colors, BROKEN seal, `POST /orchestrate` → 202 → WS →
new run appears live. (2) **LIVE on aurora via `serve` (detached — sidesteps `[orchestrator/bg-spawn-killed]`),
driven from the browser composer:** opus decompose (~20s) → claude worker → `php -l` gate → **codex critic `uncertain`
→ escalated** → new endpoint → A/B card + UNCERTAIN seal (real critic notes: "unverified contract statement… no test")
→ **reply B written to the live daemon**. The gate refused an unverified docblock contract claim — the thesis, live.

**Git:** branch `autodev/s14-dashboard-ui` (3 code commits + folds the s13-session-save docs). PR pending (supersedes #27).
**Gotchas:** `[ui/serve-uidir-reporoot]`, `[ui/verdict-not-persisted]`. Aurora reset to master, temp branch deleted.

---

## s13 — 2026-07-02 — P2 dashboard BACKEND shipped (design-gate → 4 gated modules → PR #26 merged)

**Context:** s12 closed the orchestrate live-proof; s13 priority = P2 localhost dashboard. Ran a **design
gate FIRST** (s11 pattern): Plan subagent authored `docs/superpowers/specs/2026-07-02-p2-dashboard-design.md`;
🔴 forks surfaced to the operator. Operator steered two ways that reshaped the spec: (1) frontend on the
**same stack as open-warehouse** (React 19 + Vite + TanStack + shadcn/Tailwind + zustand — shadcn/Tailwind
is the point, NOT open-warehouse's axios→Laravel coupling); (2) pick transport + run-model **from our donor
references, not invent** → dispatched parallel Explore agents over **AO** and **OD**. Findings: both donors
use HTTP `/api` + React-Query + **SSE**; OD has a per-run `runs/<id>/events.jsonl`; **AO has no transcript
UI** (confirms `[ao/ui]`). Resolved forks: keep our WS (not SSE — already gated), OD-style per-run **manifest**,
read + escalation + **launch orchestrate** in scope, bind 127.0.0.1. New feedback memory: **check donor refs
first on any architectural fork.**

**Four backend modules — each sonnet TDD → controller spec-check → codex GPT-5.5 gate → re-critic (never
self-certified):**
1. **run manifest** (`recordRun` capability) — `<stateDir>/runs/<run-id>.json` after enqueue; best-effort,
   R1-safe (report family). codex: 1 High + 2 residuals, all `[ts/fail-closed]` (throwing logger / message
   getter / non-string toString) → fixed + regression tests → APPROVE.
2. **read endpoints** — `GET /runs`, `/runs/:id`, `/tasks/:id/runtime[/:name]`. codex: 1 High (symlink
   follow) + 4 Med → symlink+size **TOCTOU-hardened** (no-follow fd + fstat), best-effort never-500, bounded
   reads → APPROVE.
3. **serve verb + static** — `serve [--port N]` binds 127.0.0.1, serves `dist/ui` as LAST fallback. codex:
   1 High (**intermediate symlink-dir escape** — lstat+O_NOFOLLOW only guard the FINAL component) → **realpath
   containment**; SPA fallback via cross-platform lexical check (errno differs by OS). 1 TOCTOU residual
   documented + codex-accepted (needs openat2, unavailable in Node; matches serve-static). → APPROVE.
4. **POST /orchestrate** — 202-async + single-flight (409), R1 preserved (api gets only a thin `onOrchestrate`
   callback; `buildOrchestrator` shared with the CLI verb). codex: 1 Med + 1 Low (`[ts/fail-closed]` again +
   log-forging) → fail-closed background chain + `flattenForLog` → APPROVE.

**Result:** 447 tests / 2 skip, typecheck clean, **CI green 4/4**, PR **#26 squash-merged → `main` `5a7963a`**.
R1 trip-wire green; no new `BlackboardRepository` method; `src/api/**` imports nothing from gate/worker/
critic/worktree/orchestrator. **Module 5 (the React/Vite UI itself) is NEXT** — paused for operator layout/UX
input. Editing note: literal control-byte regex literals are unmaintainable via the Edit tool — write control
classes via char-code checks (`codePointAt`) or `\r\n`-style escapes, never literal bytes.

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
