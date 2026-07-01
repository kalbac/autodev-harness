# OpenHands — analysis & what to steal

> Second donor tool for Autodev Harness. Analyzed 2026-07-01 against the live repo
> and docs (not from memory). Sources at the bottom.
> Repo: `github.com/OpenHands/OpenHands` — MIT, ~79k★, beta.

## What OpenHands is

A self-hosted "developer control center for coding agents and automations." It runs
multiple agent backends (its own OpenHands agent, Claude Code, Codex, Gemini) on
local / remote / cloud infra, via an **Agent Server** (REST API). An optional
**Automation Server** handles scheduled / event-triggered runs (Slack, GitHub,
Linear, webhooks).

## Stack — why this matters for us

- **Backend:** Python (~65%). **Frontend:** TypeScript "Agent Canvas" (~34%). **MIT.**
- AO (our fork base) is **Go daemon + Electron**. So OpenHands is **NOT a code-merge
  donor** — we cannot graft its Python into AO's Go. It is a **donor of ideas and
  patterns**, and potentially a **worker backend** (see ACP below). MIT means we can
  freely reuse its concepts and code where a port makes sense.

## Architecture (the signature design)

A deliberately **tiny core**:
- a **stateless Agent** that emits **Actions**;
- a **Conversation** that runs the loop and stores an **append-only EventLog**;
- a **Workspace** (local process *or* Docker container) that executes Actions and
  returns **Observations**;
- an **LLM** wrapped by **LiteLLM** for provider portability.

Everything else — memory compression, microagent knowledge, sub-agent delegation,
security review, stuck detection — is a small **auxiliary service hanging off the
event stream**. This event-stream (Action↔Observation, append-only) is the thing that
makes trajectories complete, replayable, and auditable.

## What to steal — ranked by fit with our mission

Our mission is *"let agents code, but never let them merge bullshit."* Ranked by how
directly each OpenHands feature serves that:

| # | Steal | Why it fits us | Donor form |
|---|---|---|---|
| 1 | **Security analyzer + confirmation policy** (risk levels LOW/MEDIUM/HIGH/UNKNOWN → require approval before an action runs) | This is our gate ethos, but **at the action level** — complementary to our PR-level GPT-5.5 critic. Map HIGH/contract-zone actions → mandatory confirmation. | pattern (reimplement) |
| 2 | **Event-stream / append-only EventLog** (Action↔Observation trajectories) | Better auditability + process visibility than AO's session model. Feeds our anti-drift critic real trajectories, not just diffs. | pattern (heavy) |
| 3 | **ACP (Agent-Client Protocol) + multi-backend** | AO already has `--harness`; OpenHands agents speak ACP. Path: **run OpenHands as a worker backend inside our harness**, or borrow ACP as our worker contract. | integration |
| 4 | **LiteLLM provider layer** | This is *how* OpenHands gets "any model." Directly relevant to our Tier-1 goal: **per-task model routing**. Consider LiteLLM under our router. | library |
| 5 | **Microagents** (keyword-triggered, repo-specific knowledge injection) | Elegant alternative to a monolithic INVARIANTS prompt: inject "this is a contract zone, here are the rules" *only* when contract-zone files appear. | pattern |
| 6 | **Sandboxed Docker runtime** (Workspace: process or container) | Stronger isolation than AO's git worktrees for risky execution. Optional, per-task. | pattern/library |
| 7 | **Stuck detection** | Directly our autodev-loop watchdog/circuit-breaker, already designed. Cross-check their heuristics against ours. | pattern |
| 8 | **Eval harness** (SWE-bench Verified ~77% w/ Sonnet 4.5, SWT-Bench, Commit0, GAIA) | Lets us **measure** whether the harness (critic gate on/off) actually improves outcomes. Turns "never merge bullshit" into a number. | methodology |
| 9 | **Automation Server** (scheduled/event-triggered, Slack/GitHub/webhooks) | Maps to autodev-loop's Telegram escalation + scheduled anti-drift runs. | pattern |

## How OpenHands relates to AO (our base)

They overlap and differ usefully:
- **Both:** multi-agent-on-one-machine, self-hosted, REST/daemon, harness-agnostic
  (AO `--harness` ≈ OpenHands ACP/multi-backend), bring-your-own-model.
- **AO wins:** minimalist Electron UI + kanban (our reason to fork it).
- **OpenHands wins:** event-stream auditability, risk-based action gating, sandbox
  runtime, a real eval harness, LiteLLM model portability.

**Conclusion:** AO stays the **body + UI + source of truth**. OpenHands is a **pattern
library** for the intelligence layer — its security-analyzer and event-stream ideas
slot directly next to autodev-loop's critic gate and contract zones. Where a concept
is proven in OpenHands' Python and painful to reimplement, evaluate **running
OpenHands as an ACP worker backend** rather than porting.

## Open questions (verify before committing)

- Does AO's `--harness` already speak ACP, or would OpenHands-as-worker need a shim?
- LiteLLM vs AO's native model handling — adopt LiteLLM, or just its routing idea?
- Is the security-analyzer worth porting to Go, or run it only in OpenHands-backed workers?

## Sources

- [OpenHands GitHub](https://github.com/OpenHands/OpenHands)
- [Security & Action Confirmation — OpenHands Docs](https://docs.openhands.dev/sdk/guides/security)
- [The OpenHands Software Agent SDK (arXiv 2511.03690)](https://arxiv.org/pdf/2511.03690)
- [OpenHands Deep Dive & Build-Your-Own Guide (dev.to)](https://dev.to/truongpx396/openhands-deep-dive-build-your-own-guide-1al0)

## Related

- `../VISION.md` — donor tools & single-source-of-truth rule.
- `../reference/autodev-loop-runbook.md` — our critic/gate/watchdog design (overlaps #1, #7).
- `../FUTURE-BACKLOG.md` — OpenHands-derived candidate features.
