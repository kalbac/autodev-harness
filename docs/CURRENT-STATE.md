# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (entering s47)

A working **Node daemon + web dashboard**. The core loop (P1) and dashboard (P2) are
shipped; the attended **live-orchestrator presence** (chat as the project's main
screen) is shipped; the **unattended-autonomy half** of `adr/004` is partly built (2 of
~5 slices). `main` is clean and synced (s46 = PR #77 merged, `680b9fa`, CI 4/4).

**s47 is a discussion-first session** (operator-flagged): a docs cleanup + new project
goals/ideas talk — see Current focus.

## Phase status

| Area | Status |
|---|---|
| Core loop (P1, headless) | ✅ shipped, parity-proven against the PS oracle |
| Web dashboard (P2) | ✅ product-track items 1–4 done; general polish ongoing |
| Attended live-orchestrator presence (`adr/004`) | ✅ shipped (s40, PR #72) |
| Unattended autonomy (`adr/004`) | 🚧 partly built — see below |
| Critic model | ✅ codex `gpt-5.6-luna` (calibrated s44; **pin it**) |

**Unattended-autonomy half (`adr/004`) — built vs remaining:**
- ✅ Slice 1 — overnight escalation supervisor (deterministic reason-routing, s45)
- ✅ Slice 2 — overnight presence toggle (global presence × per-project opt-in, s46)
- ⬜ Morning report (batch-narrate `.autodev/decision-journal.ndjson`, reuses the s40 narrator)
- ⬜ Per-project **north-star** concept doc (onboarding-created anti-drift anchor)
- ⬜ Mandatory anti-drift critic (intent vs cumulative diff)

## Current focus (s47)

1. **Docs cleanup (in progress).** Two diseases fixed: (A) CURRENT-STATE had become a
   session-log clone; (B) foundational docs (README/CLAUDE/VISION/AGENT-RULES) still
   told the superseded "fork AO / Go / Electron / day-zero" story. Added
   `PRINCIPLES.md` (the constitution — invariants + *why*, per the GPT-dialog advice).
2. **"Project profiles" / WP-WC domain pack.** Operator's favorite idea from the GPT
   dialog: the harness is stack-agnostic (knows nothing about WP/WC conventions);
   a *profile* = a reusable domain-knowledge + config pack per project type that makes
   worker/critic/gates domain-aware. Pending the exact dialog fragment → brainstorm.

## NEXT ACTIONS

- **This session:** finish docs cleanup (wire `PRINCIPLES.md` into `DOCS-INDEX`/`DOCS-SCHEMA`); commit the docs batch.
- **Project profiles:** get the operator's GPT fragment → brainstorm → spec. May re-order the `adr/004` backlog.
- **Remaining `adr/004` slices** (each its own brainstorm→spec→plan): morning report · north-star doc · mandatory anti-drift.
- **Metrics** (GPT suggestion, decide if/when): a lightweight harness for autonomy-%, rework-cycles, first-pass gate-success, critic FP/FN — the numbers that prove the gate's value.
- **Carried:** agent-ci synthetic `GITHUB_REPO` for non-GitHub repos · the overloaded `blocked` EscalationType (v1 parks all) · chat-runtime → TanStack AI + AG-UI migration (own future brainstorm, `FUTURE-BACKLOG`).

## Open questions

- **Project-profiles scope** — pending the operator's dialog fragment (risks section + WP/WC domain-pack bullets).
- **s45 PR status** — `autodev/s45-carried-items` (overnight escalation supervisor): confirm whether it merged or is still pending.
- **Merge policy reconciliation** — `AGENTS.md` grants a standing "agent merges without waiting"; recent practice (s44+) is the operator's in-turn "merge PR #N". Pick one and make the docs agree.

## Recent sessions (full detail → `SESSION-LOG.md`)

- **s46** — overnight presence toggle (`adr/004` slice 2): global settings store + sidebar UI + daemon wiring; 4-pass luna gate; live-proven. PR #77 merged (`680b9fa`), CI 4/4. GOTCHAS 69→70.
- **s45** — 2 carried fixes + overnight escalation supervisor (`adr/004` slice 1); 4-pass luna gate; live-proven twice. Branch `autodev/s45-carried-items` (PR status open, see above).
- **s44** — `gpt-5.6-luna` promoted as critic (calibrated 12/12) + reply-B poison-fix.
- **s43** — reply-B cycle live-proven + `blocked`-state shipped (PR #74).
- **s42** — critic-is-a-correctness-gate (`adr/005`) + reply-B carries critic feedback (PR #73).
- **s41** — first real CI run on a real task, operator-observable end-to-end → DONE (`3609a2c`); 4 findings.
- **s40** — attended live-orchestrator presence shipped, chat = main screen (PR #72).

## Environment (verified s46)

- **Daemon:** `node dist/index.js serve` (:4319, daemon-global, serves `dist/ui`) or `node dist/index.js run` (headless, from the project dir). **Rebuild BOTH bundles** after backend changes (`npm run build` AND `npm run build:ui`).
- **Presence store:** `~/.autodev/settings.json` (`{overnight:{enabled}}`); `GET`/`PATCH /settings`. Per-project opt-in: `autonomy.overnight.enabled` in the project `.autodev/config.yaml`. Overnight runs on the AND, presence read fresh per trigger.
- **Test repo:** `woodev-shipping-plugin-test` (registry `~/.autodev/projects.json`, path `D:\Projects\wordpress\woodev-shipping-plugin-test`, on `autodev/main`). `.autodev` is git-excluded, so seeding never dirties the tree.
- **Critic:** codex via the `codex:codex-rescue` subagent — **pin `--model gpt-5.6-luna`**.

## Related

- `VISION.md` — mission anchor · `PRINCIPLES.md` — the invariants and why.
- `SESSION-LOG.md` — full session history · `GOTCHAS.md` — mistakes to avoid.
- `adr/004` — live-orchestrator presence + post-review autonomy (the doctrine driving the remaining slices).
- `FUTURE-BACKLOG.md` — deferred features / tech debt.
