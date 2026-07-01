# SESSION LOG — Autodev Harness

> Newest entry on top. 10–20 lines per session.

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
