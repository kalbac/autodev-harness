# FUTURE BACKLOG — Autodev Harness

> Deferred features and tech debt. Not scheduled; parked with rationale.

## Deferred features

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

## Related

- `VISION.md` → tier plan. `CURRENT-STATE.md` → what's actually next.
