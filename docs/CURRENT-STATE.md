# CURRENT STATE — Autodev Harness

> **Live status only** — where we are, what's next, what's open. This file is a
> snapshot, **not a history**: at session end the previous session's block is
> *replaced*, and the full narrative goes to `SESSION-LOG.md` (see `DOCS-SCHEMA.md`).
> Anchors: `VISION.md` (mission) · `PRINCIPLES.md` (the invariants).

## Where we are (entering s49)

A working **Node daemon + web dashboard**. The core loop (P1) and dashboard (P2) are
shipped; the attended **live-orchestrator presence** (chat as the project's main
screen) is shipped; the **unattended-autonomy half** of `adr/004` is partly built (2 of
~5 slices). `main` is clean and synced (s48 = Authority Model docs merged, `c6c2343`;
s46 = PR #77, `680b9fa`).

**s48 was the Authority Model audit + `adr/006` (docs only, no product code — operator
scoped it narrow).** The audit found the write-authority boundary **half-closed**: the
task contract + gate config are already worker-inaccessible, but the machine gate reads
its zone/guard/CI **definitions from the worktree** (5 findings, codex-luna-reviewed).
Enforcement is deferred to a phased plan in `adr/006`. Next priority: **Profiles / WP-WC
Qualification Layer** (depends on the Authority Model), with the `adr/006` Phase-1
enforcement fix as a parallel gated task (see NEXT ACTIONS).

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

## What s48 delivered (Authority Model audit + `adr/006`)

- **Audit** (`wiki/authority-model-audit-2026-07.md`) — traced worker write-scope vs the
  oracle in code. **Sound (5 items):** task contract + gate config live in git-excluded
  `.autodev` (worker-inaccessible); the fence bounds writes to `file_set`; routing reads
  main-root INVARIANTS. **5 holes:** (1) the gate reads oracle *definitions* from the
  worktree; (2) `contract.constitutionPaths` is dead config; (3) scaffold points contract
  files at git-excluded `.autodev/…` → absent from worktree → gate zone checks vacuous
  (verified live); (4) no capability/protected-paths model; (5) missing oracle fails open.
- **`adr/006`** — capability-based Authority Model: oracle *definitions* from a trusted
  root, *execution* against the worktree, *changes* via operator bless. Phased enforcement
  (not built s48): Phase-1 definition integrity · Phase-2 executable-input protected-paths ·
  Phase-3 profiles.
- **`PRINCIPLES.md` +2** — #14 "worker does not write its own oracle" (write-authority,
  distinct from #2) + #15 "gate proves only formalized properties" (review risk 3). 15 total.
- **codex `gpt-5.6-luna` reviewed the audit + ADR** — corrected an overstated CI claim,
  scoped the "sound" framing (executable-input tampering ≠ closed by trusted-root reads),
  and flagged the `guardStillRed` bypass + fail-open. All folded in.

## The thrust — Authority Model → Profiles (from the external review)

`wiki/architecture-review-external-2026-07.md` details it. The chain, order load-bearing:

```text
Authority Model  →  Profiles / Qualification Layer  →  two reports  →  Evaluation Corpus
```

- **Authority Model** — audited s48; formalized in `adr/006`; enforcement phased (Phase-1
  is a queued gated task, not yet built). This is the prerequisite the profiles thrust
  depends on (a profile over an unprotected oracle is theater).
- **Profiles / Qualification Layer** — a reusable per-project-type proof pack (WP/WC
  first): the harness proves the *process*, the profile proves the *product*. Our
  `gate.agentCi` is the substrate; a profile productizes it. (The `adr/004` **north-star**
  doc likely folds into this.)

## NEXT ACTIONS

- **`adr/006` Phase-1 (queued gated task) — definition integrity:** move the gate's
  `loadInvariants`/`loadGuardPairs` (incl. `guardStillRed`'s reload) to the trusted root;
  wire `contract.constitutionPaths`; fail closed on a configured-but-unreadable oracle.
  Touches the contract-zone contour → full TDD → luna critic → live-prove. Records the
  "new zone no longer self-enforces in the same run" behavior-change gotcha.
- **s49+ (priority) — Profiles / WP-WC Qualification Layer:** brainstorm→spec→build
  (depends on the Authority Model; can interleave with Phase-1). Fold in the `adr/004`
  north-star concept. Phase-2/3 protected-paths land here.
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

- **s48** — Authority Model audit (5 sound / 5 holes, worker write-scope vs the oracle) + `adr/006` (capability model, phased enforcement) + `PRINCIPLES.md` +2 (#14/#15); codex-luna-reviewed; GOTCHAS 70→71. Merged to `main` (`c6c2343`).
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
