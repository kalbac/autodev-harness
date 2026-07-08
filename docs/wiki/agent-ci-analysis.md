# redwoodjs/agent-ci — analysis & 5-way verdict

> The operator's second pivot candidate this cycle (after agency-agents, s32), with a
> stronger "must-have" prior going in. Analyzed 2026-07-08 (s33) from the real repo
> (README, LICENSE, repo tree, the shipped Claude Code skill) + the linked blog post —
> not from the name alone — mapped onto our anchors in `../VISION.md`, same structure
> as `agency-agents-analysis.md`.
> Repo: `github.com/redwoodjs/agent-ci` — FSL-1.1-MIT (fair-source, not permissive OSS),
> active (created 2026-02, pushed 2026-07-03), 711 stars / 17 forks, TypeScript + Rust.

## TL;DR verdict

**Not a must-have, not redundant, not a core-architecture donor.** It solves a real but
**different** problem — making an AI coding agent's OWN pre-push CI run be a **faithful,
fast, local replica of the real GitHub Actions runner** — not our problem (an
**independent** adversarial critic gate). Verdict is closer to `agency-agents`'
**#4 not-for-us** than the operator's "must-have" lean suggested, with one genuine
**#2 adopt-alongside** footnote: it could optionally harden our machine gate for
projects that already have their own `.github/workflows/*.yml`, as an ADDITIONAL
check layered onto (never replacing) the independent critic. Recon-first discipline
paid off again — the name and blog title read as agent-orchestration-adjacent; the
substance is a CI-execution speed/fidelity tool.

## What it actually is

**"Local GitHub Actions for your agents"** — a from-scratch reimplementation of the
GitHub Actions *orchestration/API layer* (Twirp endpoints, the Azure Block Blob
artifact protocol, the cache REST API) that feeds jobs to the **unmodified, official**
`actions/runner` binary in Docker, so `runs-on: ubuntu-latest` workflows execute
locally, bit-for-bit compatible with GitHub.com — not a re-implementation/shim like
`nektos/act` (their own comparison table draws this line explicitly).

- **Core pitch:** run your repo's real `.github/workflows/*.yml` on your own machine,
  against your **current working tree** (uncommitted changes included, no
  commit/stash needed), with **~0 ms cache round-trips** (bind-mounted `node_modules`/
  pnpm-store/tool-cache instead of upload/download) and **pause-on-failure**: a failed
  step keeps the container alive with full state, you (or your agent) fix the file on
  the host, then `agent-ci retry` re-runs just that step.
- **Agent-facing surface, concretely:** `--json`/`AGENT_CI_JSON=1` emits an NDJSON
  event stream (`run.start`/`job.start`/`step.finish`/`run.paused` with a `retry_cmd`/
  `run.finish`); `AI_AGENT=1` suppresses animated rendering; a shipped **Claude Code
  skill** (`skills/agent-ci/SKILL.md`) tells an agent to run
  `agent-ci run --quiet --all --pause-on-failure` before every push and gives it the
  exact retry contract. This is real, deliberate agent-ergonomics — not just a human
  CLI with an agent afterthought.
- **License: FSL-1.1-MIT** (Functional Source License — "fair source", not
  OSI-permissive). Grants use/copy/modify/redistribute for any purpose EXCEPT a
  "Competing Use" (offering it as a substitute commercial product/service); converts
  to MIT after the FSL's standard change-date window. Not a blocker for using it as an
  internal tool (we are not building a competing CI-runner product), but a real
  contrast with AO/OpenHands/Open Design's fully permissive MIT/Apache-2.0 — worth
  flagging, not disqualifying.
- **No UI, CLI + a small Rust runner (parity/perf track, not yet npm-packaged).**
  No multi-agent concept, no task/queue, no worker/critic split, no independent
  review of any kind — it is a single-command, single-repo, single-agent tool.

## The blog's actual claim ("the agentic dev loop")

The linked post (`agent-ci.dev/blog/the-agentic-dev-loop`) frames the problem as: an
agent runs `pnpm test` locally, gets green, but that's only **"a slice of the
contract, not the whole thing"** — typecheck/lint/integration/build steps that only
run in a clean CI environment are missed, so the agent ships confident-but-wrong
commits. Its loop is: agent implements → runs the FULL CI locally via Agent CI → on
failure, pause/fix/retry → once green, commit/push. Its own words: **"Commits in this
loop become save points rather than publications"** and, tellingly, **"CI becomes a
formality — a verification of something you already proved."**

That last line is the crux for us. The post **never mentions code review, an
independent reviewer, or any gating beyond re-running the SAME CI the agent already
trusts, faster and more faithfully.** "Prove it locally, then CI is a formality" is a
reasonable claim for making an agent's *own* environment-fidelity gap disappear — but
it is close to the opposite of this project's thesis: **self-critique is never the
gate** (`AGENTS.md`). Agent-CI make the agent's self-check more ACCURATE; it does not
make it INDEPENDENT. Those are different, non-substitutable properties.

## Mapped against our VISION anchors / frozen skeleton (6 axes)

| Our axis | agent-ci |
|---|---|
| 1. State: file-blackboard = truth | ❌ no task/queue/state concept at all |
| 2. Pluggable worker/critic adapters | ❌ no role concept — one agent, one CI run |
| 3. Checkpoint: commit-after-**independent**-gate | ⚠️ has "commit as save point," but the gate is the SAME agent's own CI, not an independent reviewer — philosophically the opposite half of our checkpoint rule |
| 4. Isolation: per-task git worktree | ❌ different mechanism — Docker container per CI job (dependency/env fidelity), not git-branch task isolation; operates on the whole working tree, not a per-task slice |
| 5. Gate: independent diff-critic, self-critique rejected | ❌ **the core mismatch** — its explicit philosophy is "prove it yourself locally, CI becomes a formality"; no adversarial second opinion anywhere |
| 6. Routing: model-by-complexity | ❌ not an LLM-orchestration tool at all — it never calls a model itself |

Overlap on the axes that define our project is **effectively zero**, and axis 5 is a
near-direct philosophical tension, not just an absence.

## The 5-way frame (operator's)

1. **Redundant?** No — it doesn't replace any harness component; it solves a problem
   (local CI-environment fidelity) we don't currently have a tool for, but that isn't
   the same as needing THIS tool urgently (see #2).
2. **Adopt-alongside?** **Weakly, optionally, and only for projects that already have
   their own GitHub Actions CI** — the one real idea worth banking: let the machine
   gate optionally replay a target project's real `.github/workflows/*.yml` locally
   (via `agent-ci run --all --json`, parsing the NDJSON stream) as an ADDITIONAL check
   layered onto — never instead of — the existing worktree `success_commands` gate AND
   the independent codex critic. This would catch environment-drift failures neither
   of those currently can (a workflow-only step, a matrix combination, a clean-container
   quirk). Needs Docker as a new host dependency; FSL license is fine for this
   non-competing internal use. **Not urgent — no current project in this harness's
   orbit has been reported hitting this specific gap**, unlike e.g. the s31
   `.serena`/`.autodev` churn bug, which was found live. Parked as a FUTURE-BACKLOG idea.
3. **New reference (donor to graft)?** Marginal, same verdict class as agency-agents'
   convert/install matrix: the "official runner binary + full server-side API
   emulation, not a re-implementation" design is a genuinely clever engineering choice
   (their explicit differentiation from `nektos/act`), and "pause-on-failure, keep
   the container alive, retry just the failed step" rhymes thematically with our
   conductor's per-task retry rounds — worth a one-line nod, not a graft. Nothing here
   touches the critic/gate/isolation/orchestrator axes where AO/OpenHands/Open Design
   remain our actual references.
4. **Not for us?** Mostly yes, for the core architecture question the operator asked —
   with the #2 footnote as the one place it earns a future look.
5. **Something else (our honest read)?** It is a **CI-execution speed/fidelity tool for
   a single agent's pre-push loop**, ergonomically built for AI agents (NDJSON
   contract, a shipped Claude skill) — NOT an "agentic dev loop" in the sense our
   VISION uses the phrase (multi-role, gate-enforced, orchestrator-driven). The name
   and blog title are the misleading part; the substance is narrower and adjacent, not
   competing or foundational. Same shape as agency-agents: a superficially-adjacent
   tool that, read carefully, sits one layer to the side of what we're building —
   except here the adjacent layer (CI verification) is at least on the SAME general
   topic (gating quality) as our differentiator, which is why the operator's "must-have"
   instinct isn't crazy, just aimed at the wrong altitude: it would harden a check we
   already have (the machine gate), not add the one we're missing (independent review).

## Why this isn't a "must-have" despite the on-topic title

The operator's lean was reasonable to test — "agentic dev loop" is literally our
domain's vocabulary. But the actual value proposition (faithful local CI replay,
~0 ms caching, pause/retry) targets a failure mode we don't currently have evidence of
hitting: our conductor already runs `success_commands` directly in an isolated
worktree per task (a simpler, dependency-free local-first check by design — see
`gotcha [conductor/real-repo-run]`), and the REAL adversarial check (the independent
codex critic) is a code-review pass, not a CI re-run — agent-ci has nothing to say
about that half of our pipeline at all. Adopting it now would add a Docker dependency
and CLI-wiring effort to hedge against a gap we have not observed, ahead of harder work
(the chat brainstorm, web-UI polish) with clearer, evidenced payoff.

## Sources

- [redwoodjs/agent-ci GitHub](https://github.com/redwoodjs/agent-ci) — FSL-1.1-MIT
- `README.md`, `LICENSE`, `skills/agent-ci/SKILL.md` (read directly from the repo, 2026-07-08)
- [agent-ci.dev/blog/the-agentic-dev-loop](https://agent-ci.dev/blog/the-agentic-dev-loop)

## Related

- `../VISION.md` — donor tools & single-source-of-truth rule; frozen skeleton (6 axes).
- `agency-agents-analysis.md` — the s32 precedent this recon deliberately mirrored
  (same 5-way frame, same "read the real repo before concluding" discipline).
- `../FUTURE-BACKLOG.md` — the optional gate-hardening idea seeded here (§2 above).
