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

## Git ownership — the agent drives, the operator approves

- **The agent always performs merges, commits, and PRs itself** — never hand these
  back to the operator as manual steps.
- The operator's only role in git is **approval when a merge requires operator
  confirmation** (e.g. the Claude Code permission classifier blocks `gh pr merge`).
  In that case: surface the exact command, get approval, then the agent runs it.
- Do not ask the operator to "merge in the UI" or "run this yourself" as the default
  path — that is the fallback only when approval cannot be obtained in-session.
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
**independent codex GPT-5.5 review gate** → fix subagent with a regression test.
Self-critique is never the gate. Re-critic in-place fixes; a mechanical
critic-advised fix is gated by its regression test. See `CLAUDE.md`.

## Related

- `CLAUDE.md` — session start/end protocol, coding conventions, MCP tools.
- `docs/VISION.md` — mission anchor (read first each session).
- `docs/CURRENT-STATE.md` — phase status + next actions.
