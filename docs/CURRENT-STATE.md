# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (entering s48)

A working **Node daemon + web dashboard**. The core loop (P1) and dashboard (P2) are
shipped; the attended **live-orchestrator presence** (chat as the project's main
screen) is shipped; the **unattended-autonomy half** of `adr/004` is partly built (2 of
~5 slices). `main` is clean and synced (s46 = PR #77 merged, `680b9fa`, CI 4/4).

**s47 was a docs-consolidation + external-feedback session.** The docs cleanup shipped
(see below), and an external agent review (`wiki/architecture-review-external-2026-07.md`)
surfaced a new strategic thrust: **Authority Model → Profiles / Qualification Layer**.
That thrust — not more autonomy polish — is judged the next priority (see NEXT ACTIONS).

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

## What s47 delivered (docs consolidation)

- **Fixed the stale foundation** — README/CLAUDE/VISION/AGENT-RULES no longer tell the
  superseded "fork AO / Go / Electron / day-zero" story; AGENT-RULES had the
  single-source-of-truth rule inverted → corrected to the blackboard.
- **Slimmed CURRENT-STATE** 139 KB → ~8 KB (snapshot, not a log; replace-not-append
  discipline in `DOCS-SCHEMA`).
- **Added `PRINCIPLES.md`** — the constitution (13 invariants + *why*), per the external
  review's advice; wired into `DOCS-INDEX`/`DOCS-SCHEMA`. Made `wiki/`'s role explicit
  (Architecture Notes — rationale, not API) and saved the external review there.

## The new thrust — Authority Model → Profiles (from the external review)

`wiki/architecture-review-external-2026-07.md` details it. The chain, order load-bearing:

```text
Authority Model  →  Profiles / Qualification Layer  →  two reports  →  Evaluation Corpus
```

- **Authority Model** — "the worker must never control its own oracle". Acceptance
  criteria, hidden tests, gate config, CI, protected paths, release config must be
  **outside the worker's write authority**, by capability not role name. We have pieces
  (orchestrator forbidden-paths, contract-zones) but no unified, audited model.
- **Profiles / Qualification Layer** — a reusable per-project-type proof pack (WP/WC
  first): the harness proves the *process*, the profile proves the *product*. Our
  `gate.agentCi` is the substrate; a profile productizes it. (The `adr/004` **north-star**
  doc likely folds into this.)

## NEXT ACTIONS

- **s48 (priority) — Authority Model, scoped narrow:** audit what the worker can
  currently write into its diff vs the oracle artifacts (tests, `ci.yml`, gate config)
  and whether the gate catches tampering → `adr/006` (capability-based authority) +
  `PRINCIPLES.md` hardening (risk 3 "gate proves only formalized properties" + sharpen
  "worker doesn't write its own oracle"). Fix enforcement only if the audit finds a hole.
- **s49+ — Profiles / WP-WC Qualification Layer:** brainstorm→spec→build (depends on the
  Authority Model being sound). Fold in the `adr/004` north-star concept.
- **Remaining `adr/004` slices** (after/interleaved, each own brainstorm→spec→plan):
  morning report · mandatory anti-drift · (north-star → folded into profiles).
- **Metrics / Evaluation Corpus** (GPT suggestion, decide if/when): autonomy-%,
  rework-cycles, first-pass gate-success, critic FP/FN — the numbers that prove the gate.
- **Carried:** agent-ci synthetic `GITHUB_REPO` for non-GitHub repos · overloaded
  `blocked` EscalationType (v1 parks all) · chat-runtime → TanStack AI + AG-UI (`FUTURE-BACKLOG`).

## Open questions

- **s45 PR status** — `autodev/s45-carried-items` (overnight escalation supervisor): confirm whether it merged or is still pending.
- **Merge policy reconciliation** — `AGENTS.md` grants a standing "agent merges without waiting"; recent practice (s44+) is the operator's in-turn "merge PR #N". Pick one and make the docs agree.

## Recent sessions (full detail → `SESSION-LOG.md`)

- **s47** — docs consolidation (stale foundation fixed · CURRENT-STATE 139 KB→8 KB · `PRINCIPLES.md` added) + external agent review processed → Authority-Model→Profiles thrust defined. Merged to `main` (`7759346`).
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
