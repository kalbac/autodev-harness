# FUTURE BACKLOG — Autodev Harness

> Deferred features and tech debt. Not scheduled; parked with rationale.

## Web UI: pilot → product (operator steer, s25 2026-07-05)

The current dashboard is a **working pilot**, NOT the final product UX. The full end-to-end skeleton
works (register → scaffold → drive → gate → verdict → settings → theme), but the envisioned
product-completeness (much of it the Open Design donor's UX draw) is unbuilt. **Operator decision:
finish debugging + polishing the WEB UI to a real product BEFORE the desktop wrap** — desktop is
deferred until then (see below). Near-term product-UX backlog, roughly in build order:

- **PATH-scan auto-detection of installed CLI agents** — discover `claude`/`codex`/etc. on `PATH`
  (+ version) instead of hand-typing `adapter`/`exe` in settings. Reuse Open Design's detection
  logic (Apache-2.0). The single biggest "pilot → product" jump. (Also listed under Open Design
  candidates below — this is now a committed near-term track, not a maybe.)
- **Preset model + effort pickers per adapter** — dropdowns from a known model/effort list per
  adapter, replacing today's free-text `model`/`effort`/`ladder` fields (which accept typos silently).
- **Richer role-matrix editing** — a first-class per-role editor (orchestrator/worker/critic/planner)
  over the raw config fields, with adapter→model→effort constrained by the detected/known sets.
- **Skills / plugins / MCP surface** — expose the extensibility trio in the UI (Open Design pattern),
  not just file-based config.
- **Per-field help — tooltips / option-description modals** (operator ask, s27 2026-07-06). Many
  settings options are not self-explanatory ("even I don't understand how many of them work" — the
  operator; a new user will be lost). Add inline help affordances (a `?` tooltip, or a modal with a
  fuller description) to non-obvious fields — especially the roles matrix (adapter/model/effort/ladder,
  the heterogeneity policy) and the gate/worktree/branch fields. Should land relatively EARLY in the
  polish pass (it lowers the comprehension barrier for the whole settings surface), not deferred to the
  end. Copy source: distill from `docs/` (roles/adapters, heterogeneity §9, gate) into short field blurbs.
- **General UX polish pass** — the pilot's rough edges once the above land.
- **i18n / l10n — Russian UI language support** (operator ask, s27 2026-07-06). Implement a real i18n
  layer (message catalogue + a language switch) so the UI can render in Russian (and stay
  English-extensible). Operator's call: schedule this **near the END** of the pilot→product track (or
  wherever it fits best) — it's a cross-cutting refactor (every user-facing string routes through the
  i18n layer) with the most churn-risk, so it pays to do it once the screens/copy have stabilised.
  Pairs naturally with the per-field help item (both are string/copy surfaces — build the help blurbs
  i18n-ready so they translate too). NB: the operator/artifact language split still holds (Russian is a
  UI-render choice for the product's end users; docs/code/commits stay English per `AGENTS.md`).

Rationale for sequencing: a desktop shell over an unfinished web product just wraps the gaps in a
heavier package. Polish the product surface first; wrap it once it's real.

## Deferred features

- **Desktop wrap (Electron/Tauri over the loopback API)** — DEFERRED by operator (s25) until the web
  UI is debugged + polished to a real product (see "pilot → product" above). Additive when it comes
  (the daemon already serves install-relative); needs an IA/UX discussion before building.

- **Tier-2: native critic-gate concept in AO** — model the critic verdict + gate as
  first-class daemon state, not just `ao review submit`. Deferred until Tier-1 proves
  the fork is worth deepening.
- **Tier-2: model-by-complexity router in the UI** — let the operator see/tune the
  complexity→model mapping. Depends on Tier-1 `--model` landing first.
- **Contract-zone guards as native concept** — port autodev-loop's mutation-verified
  guard registry (`GUARDS.md`) into the harness so the gate can auto-bless contracts.
- **Anti-drift critic** — periodic "intent vs diff" check (runbook §7). High value,
  but needs the basic critic gate working first.
- **Escalation → Telegram** — reuse autodev-loop's structured escalation format.
- **Apply-on-accept for escalations** (operator-flagged, s30 live run) — accepting an escalation
  (`POST /escalations/:id/reply` choice `A`) currently only moves the task to `quarantine` and releases
  the file-lock; it does **NOT** commit the worker's change (there is no apply-on-accept machinery — see
  gotcha `[escalate/replied-holds-filelock]`). So a run that escalates NEVER lands a commit even when the
  operator wants the change. This surprised the operator (he expected accept → commit). Design an
  apply-on-accept path: on `A`, optionally commit the worktree diff to the loop branch (with the same
  gate-bypass semantics an operator override implies) so accept actually merges the reviewed change,
  rather than quarantining it. Needs care re: dependents' `depends_on`/`doneIds` (why A→quarantine today).
- **Onboarding: git-exclude tooling-churn dirs by default** (operator ask, s31). Background tooling
  auto-rewrites TRACKED files and perma-dirties the tree, so `mergeAfterGate` refuses every merge and no
  task reaches DONE — hit live with `.serena/project.yml` (gotcha `[env/serena-churn-blocks-merge]`), same
  class as `.autodev` churn. When the New Project flow scaffolds `.autodev`, it should also add `.serena/`
  (and `.autodev/`) to the project's `.git/info/exclude` (or a `.gitignore`), and surface a "main tree is
  dirty" warning before the first run. Consider a preflight that lists what's dirtying the tree.
- **Dedup of a relaunched equivalent intent (backlog C, operator-flagged s29)** — relaunching the same
  intent enqueues a near-duplicate task (no guard). Add a skip/warn when an equivalent task is already
  pending/active (heuristic: overlapping `file_set` + maybe title/goal). NB: **backlog B (orphaned PENDING)
  is now CLOSED** — s31 `9e3157d` drain mode; C remains open.
- **Worker-persona catalog (operator ask, s32 2026-07-07 — from the agency-agents review)** — let a task
  or a project select a specialist **persona prompt** to prime the worker (e.g. a WordPress/WooCommerce
  persona for the woodev projects, a payments persona for billing work). Seeded by
  `github.com/msitarzewski/agency-agents` (MIT, ~280 persona `.md` files across 17 divisions —
  `engineering/engineering-wordpress-shopping-cart.md` and `-drupal-shopping-cart.md` map directly onto the
  operator's stack). The library is a **content source**, harvested/adapted, NOT a runtime dependency —
  agency-agents only *installs* prompt files, it doesn't run agents (full analysis:
  `wiki/agency-agents-analysis.md`). Scope when picked up: a `persona:` field per task/project that is
  prepended to the worker prompt (composes with, does not replace, the role matrix). Low priority — our
  differentiator is the gate, not persona breadth; this is a cheap quality lever, not a blocker.
- **Orchestrator CHAT — a real conversation, not one-shot decompose (operator vision, discussed since
  early design, resurfaced s32 2026-07-08 from the dedup live-prove's UX gap).** Today `handleIntent`
  (`src/orchestrator/orchestrator.ts`) is explicitly a **staged, TERMINATING pipeline** — one call per
  intent (snapshot → decompose → validate → enqueue → trigger → return), NOT an agentic loop; the doc
  comment says so verbatim. The operator's vision: launching a run should drop the operator into an
  actual **chat with the orchestrator** — back-and-forth, not silence — UNLESS the intent is a relaunch
  duplicate (backlog C), in which case there's nothing to discuss and a toast is enough (see the s32
  toast fix, shipped, for that narrower case). This is a **larger architectural topic, deliberately
  DEFERRED to its own brainstorm → spec → plan session** (same discipline as onboarding-redesign /
  shadcn-migration), NOT bundled into the s32 wrap-up. **Open question for that brainstorm, flagged
  up front:** does a live conversational orchestrator conflict with `adr/003`'s accepted role model —
  "the operator talks to an in-harness LLM orchestrator that drives the run; the **gate/enforcement
  stays deterministic** (an LLM can't talk past it)" (`docs/VISION.md` line ~21)? A chat UI must not
  let conversational back-and-forth become a side channel that bypasses the critic gate — the
  brainstorm needs to nail down exactly what the orchestrator CAN be talked into changing (task scope,
  re-decompose, abandon) versus what stays off-limits (skipping the gate, forcing a commit — that's
  `apply-on-accept`'s job, not chat's). Likely touches: a persistent orchestrator session/adapter
  (today's adapter is a single spawn-and-exit call), streaming to the UI, a new chat view/route,
  message history persistence. Do NOT start implementation without that design conversation.

## OpenHands-derived candidates (see `wiki/openhands-analysis.md`)

Ranked by fit with "never merge bullshit":

- **Risk-based action confirmation** (OpenHands security analyzer) — LOW/MEDIUM/HIGH/
  UNKNOWN risk on each action; HIGH / contract-zone → mandatory confirmation. Action-
  level gate that complements our PR-level critic. **Highest-fit steal.**
- **Append-only event-stream** (Action↔Observation trajectories) — richer auditability
  + feeds the anti-drift critic real trajectories, not just diffs.
- **OpenHands-as-ACP-worker-backend** — run OpenHands agents inside our harness via ACP
  instead of porting Python. Verify AO `--harness` ⇄ ACP compatibility first.
- **LiteLLM under our model router** — how OpenHands gets "any model"; candidate engine
  for Tier-1 per-task model routing.
- **Microagents** — keyword-triggered contract-zone knowledge injection (leaner than a
  monolithic INVARIANTS prompt).
- **Eval harness** (SWE-bench Verified / SWT-Bench / Commit0) — measure whether the
  critic gate actually improves outcomes. Turns the slogan into a number.
- **Sandboxed Docker runtime** — optional stronger isolation than git worktrees for
  risky tasks.

## Open Design-derived candidates (see `wiki/opendesign-analysis.md`)

Ranked by fit (UX-first — the operator's reason to like it):

- **PATH-scan agent auto-detection** — auto-discover installed CLI agents instead of
  manual `--harness`. **Top UX steal.** Reuse Open Design's detection logic (Apache-2.0)
  or reimplement in AO's Go daemon.
- **Three-tier UI + sidebar blueprint** — adapt to Home / Board (kanban) / Automation /
  Skills / Integrations(MCP). Both apps are Electron.
- **Model router + BYOK proxy** (SSE, SSRF-protected, any OpenAI-compatible endpoint) —
  engine candidate for Tier-1 per-task routing. Converge with OpenHands' LiteLLM idea.
- **Extensibility trio: Skills (SKILL.md) + Plugins marketplace + Integrations (MCP)** —
  make the harness pluggable, not hard-coded.
- **Pre-emit self-critique lint** — cheap worker self-check *before* the independent
  GPT-5.5 critic runs; layered gate.
- **Comment-mode surgical edits** — targeted fix application when the critic sends
  findings back.

## Candidate donors — not yet analyzed (proposed by the agent, 2026-07-01)

Fills a gap the current four donors don't center on: **worker code-editing quality
& token economy.**

- 🥇 **Aider** (`Aider-AI/aider`, Apache-2.0) — repo-map via tree-sitter, edit formats
  (diff/whole), per-change git commits, any-LLM. Best-in-class for precise, cheap
  patching. **Strongest additional candidate — analyze next.**
- **SWE-agent** — Agent-Computer Interface (ACI) design + strong eval lineage; overlaps
  OpenHands' eval, so lower marginal value.
- **Cline** — good approval UX (plan/act, checkpoints) but VS Code-bound; less fit for a
  standalone harness.

## Tech debt / risks to watch

- **Upstream merge debt** — the standing risk of any fork. Revisit branch model if
  pulling AO updates starts to hurt.
- **Two-provider critic dependency** — the gate needs codex (GPT-5.5) available;
  define graceful behaviour when it's down (park, don't silent-pass).
- **Replied escalation never cleared → silent file-lock** (`[escalate/replied-holds-filelock]`,
  found s25 live). `POST /escalations/:id/reply` writes the reply but leaves the task in
  `escalated/`, where its `file_set` blocks every future same-file run with zero operator signal.
  **Scheduled as the s26 opener (variant 1):** the reply-apply path must move the task
  `escalated → done` (accepted) or re-queue `→ pending` (redo). Codex-gate it.

## Related

- `VISION.md` → tier plan. `CURRENT-STATE.md` → what's actually next.
