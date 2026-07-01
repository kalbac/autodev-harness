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

## Tech debt / risks to watch

- **Upstream merge debt** — the standing risk of any fork. Revisit branch model if
  pulling AO updates starts to hurt.
- **Two-provider critic dependency** — the gate needs codex (GPT-5.5) available;
  define graceful behaviour when it's down (park, don't silent-pass).

## Related

- `VISION.md` → tier plan. `CURRENT-STATE.md` → what's actually next.
