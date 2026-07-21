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
- **One narrow exception:** a *verbatim quote of the operator's own words* may keep
  its original language when the exact phrasing is the point — e.g. recording which
  trigger phrase authorized a merge. Quotes are evidence, not prose; everything
  around them stays English. Do not use this to write Russian commentary.

## Git ownership — the agent drives everything

- **The agent performs ALL git and GitHub operations itself** — commits, branches,
  pushes, PRs, and merges (`gh pr merge`). Never hand a git/GH step back to the
  operator as manual work.
- **When to merge depends on presence** (reconciled s49 — docs previously granted a
  blanket auto-merge that attended practice did not follow):
  - **Attended** (the operator is in the session): the agent prepares everything —
    branch, commits, PR, gate, green CI — and the final **merge-to-main happens on the
    operator's in-turn word** ("мержи PR #N"). Do not auto-merge behind him.
  - **Unattended / overnight** (the autonomy path, `adr/004`): the standing grant
    applies — gate on the machine bar (codex-clean where required + green CI), then
    merge and move on, no waiting.
- Everything *up to* the merge is unconditionally the agent's: never pause a batch to
  ask whether to open a PR, push, or re-run the gate. The merge word is the ONLY
  attended checkpoint.
- The operator is interrupted ONLY at that checkpoint and at genuine forks where his input is 100% required
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
