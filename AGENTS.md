# AGENTS.md — Autodev Harness

> Agent contract for this repo. Companion to `CLAUDE.md` (session protocol) and
> `docs/VISION.md` (mission anchor). This file is written in **English** — see the
> language rule below.

## Operator communication & language

- **Talk to the operator (Maksim) in Russian only.** All conversational replies,
  explanations, summaries, and status updates are in Russian.
- **All durable artifacts are in English only:** docs (`docs/**`, `README`, ADRs),
  code + comments, commit messages, PR titles/bodies, and every prompt/instruction
  written for a subagent or an external critic (codex). No Russian in anything an
  agent or the git history reads.
- Net: Russian is for the human conversation; English is for everything written to
  disk or dispatched to another agent.

## Git ownership — the agent drives everything, no waiting

- **The agent performs ALL git and GitHub operations itself** — commits, branches,
  pushes, PRs, **and merges** (`gh pr merge`). This is a standing grant: do NOT wait
  for operator confirmation on a merge. Gate a merge only on the machine bar
  (codex-clean where required + green CI), then merge and move on.
- **Never** hand a GH operation back to the operator as a manual step, and never
  pause a completed, gated, green batch to ask "should I merge?" — just merge.
- The operator is interrupted ONLY at genuine forks where his input is 100% required
  (real UI/UX design decisions, scope changes, expensive unsupervised live runs) —
  never for routine git/GH mechanics.
- If the Claude Code permission classifier blocks a `gh` command in-session, that is
  a tooling prompt to approve in the moment, not a reason to defer the work to a
  future session or hand it to the operator.
- Commit/PR conventions: Conventional Commits; co-author trailer on commits and the
  Claude Code footer on PR bodies as configured.
- **Batch merges — do NOT open a PR + merge for every small change.** Small/incremental
  work (a doc tweak, a gotcha, a state-sync) is just **committed** on the working branch;
  it rides to `main` with the next substantive PR. Reserve the PR + merge cycle for a
  **meaningful batch** — a completed module (per-module PRs still apply), a coherent group
  of changes, or an explicit "land this now" from the operator. When in doubt, keep
  committing and merge less often. (Direct push to `main` is classifier-gated, so small
  commits accumulate on a branch until the batch is worth a merge.)

## Review discipline (unchanged — the project's whole point)

Substantial work follows: sonnet-5 implementer (TDD) → controller spec-check →
**independent codex gpt-5.6-luna review gate** (pin the model) → fix subagent with a regression test.
Self-critique is never the gate. Re-critic in-place fixes; a mechanical
critic-advised fix is gated by its regression test. See `CLAUDE.md`.

## UI: shadcn-first

- The `ui/` dashboard is built on shadcn's Base UI foundation (see
  `docs/superpowers/plans/2026-07-06-shadcn-ui-migration.md`). Default to
  shadcn/Base UI primitives and blocks for any new UI — a **composition** of
  shadcn primitives is NOT custom.
- Before hand-rolling any widget, verify shadcn has no equivalent; state in the
  PR/commit which primitive/block was checked and why it doesn't fit.
- Genuinely novel widgets (e.g. `DiffView`, which has no shadcn diff viewer)
  stay custom — but only after that verification, and only for the part that
  is actually novel; wrap its chrome in shadcn primitives (`Card`,
  `ScrollArea`, ...) where they fit.

## Related

- `CLAUDE.md` — session start/end protocol, coding conventions, MCP tools.
- `docs/VISION.md` — mission anchor (read first each session).
- `docs/CURRENT-STATE.md` — phase status + next actions.
