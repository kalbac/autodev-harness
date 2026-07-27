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
- **Exception — operator-facing backlog artifacts are in Russian** (operator decision,
  s52 2026-07-23): GitHub **issue titles/bodies** and **Project-board cards** — and any
  note whose intended reader is the operator — are written in Russian, because he is
  their primary reader. Technical identifiers inside them (file paths, code, gotcha
  tags, label names) stay English. Everything else in the durable-artifact rule is
  unchanged: docs, code, commits, PR titles/bodies remain English.
- **One narrow exception:** a *verbatim quote of the operator's own words* may keep
  its original language when the exact phrasing is the point — e.g. recording which
  trigger phrase authorized a merge. Quotes are evidence, not prose; everything
  around them stays English. Do not use this to write Russian commentary.

## Git ownership — the agent drives everything

- **The agent performs ALL git and GitHub operations itself** — commits, branches,
  pushes, PRs, and merges (`gh pr merge`). Never hand a git/GH step back to the
  operator as manual work.
- **DO NOT ASK "мержим?" — EVER** (operator decision, s59 2026-07-27, superseding the
  s49 attended-merge checkpoint). The merge is the agent's, attended or not. Once the
  branch has the gate's SAFE verdict and green CI, **merge it and say so in the report**.
  His words: *"ты меня уже достал с постоянными вопросами 'мержим?'"*. Asking is not
  caution here — the gate already decided, and re-asking a question a deterministic
  check has answered is exactly the theatre this project exists to remove.
  - The ONE exception is his own explicit "не мержи пока" / "подожду" on a specific
    branch. Absent that, a green batch lands.
  - **Unattended / overnight** (`adr/004`) was already this way; the two paths are now
    the same rule.
- The operator is interrupted ONLY at genuine forks where his input is 100% required —
  **oracle decisions** (what "pass" means: a corpus expectation, a contract zone, the
  critic's mandate), real UI/UX design choices, scope changes, expensive unsupervised
  live runs. **Never** for git/GH mechanics, and never for a merge.
- If the Claude Code permission classifier blocks a `gh` command in-session, that is
  a tooling prompt to approve in the moment, not a reason to defer the work to a
  future session or hand it to the operator.
- Commit/PR conventions: Conventional Commits; co-author trailer on commits and the
  Claude Code footer on PR bodies as configured.
- **A PR is for a LARGE LOGICAL UNIT, not for every "чих"** (restated with teeth, s59 —
  the rule existed and was not being followed). The measurable symptom he named: **the
  merge count was outrunning the session count.** That is the test. If a session produced
  more than one PR, the split was almost certainly wrong.
  - **One PR per session is the default.** Session docs, a gotcha, a state-sync, a
    `.gitignore` line, a config tweak — these are **commits on the working branch**, and
    they ride to `main` inside that session's substantive PR. They are never their own PR.
  - A second PR in one session needs a real reason: two genuinely independent modules
    touching different subsystems, or his explicit "land this now".
  - **Session docs are not a separate PR.** Write them onto the same branch as the work
    they describe, before it merges. s58 and s59 both got this wrong — the feature landed,
    then the docs trailed behind in their own PR, which is how one session became two
    merges. (s59 also branched the feature off `main` while the docs branch was still
    open; the fix is to do the work on ONE branch per session.)
  - When in doubt: keep committing, merge once, later.
  - (Direct push to `main` is classifier-gated, so small commits accumulate on a branch
    until the batch is worth a merge — that is the mechanism, not a reason for extra PRs.)

## Backlog — GitHub Issues + Project board (since s52)

- **The single backlog for this repo is GitHub Issues** plus the user-level Project
  board **"Autodev Harness Backlog"** (`https://github.com/users/kalbac/projects/2`).
  Board statuses: `Инбокс` → `Бэклог` → `В работе` → `Готово`.
- **Capture rule:** any out-of-scope idea, bug, or debt item discovered mid-session is
  captured **immediately** as an issue — `gh issue create` with a type label
  (`bug`/`enhancement`/`idea`/`tech-debt`/`research`/`polish`) + an `area:*` label and a
  **Russian** title/body (see the language exception above) — then added to the board
  with status `Инбокс`:
  `gh project item-add 2 --owner kalbac --url <issue-url>`.
  Never a stray `.txt` note; a code TODO must reference an issue (`// TODO(#123): ...`),
  never stand alone.
- **Triage depends on who authored the card** (operator decision, s59 2026-07-27 —
  this supersedes the earlier blanket "triage is the operator's"):
  - **Agent-authored cards go straight to `Бэклог`, not `Инбокс`.** The reasoning is his:
    if an agent captured it, the agent already judged it worth doing — parking it in
    `Инбокс` only makes him re-triage a decision that was already made. Set `Бэклог` at
    capture time; do not leave agent-created cards sitting in `Инбокс`.
  - **Operator-authored cards are his to move.** Never promote a card he created out of
    `Инбокс` — he moves those himself, or names the card and tells an agent to move it.
  - `В работе` when an agent picks the issue up on his word; `Готово` only when the work
    is merged and verified.
- **Every operator-facing feature needs a UI surface** (operator decision, s59): a
  capability that exists only as a YAML key or a CLI flag is, in practice, invisible —
  he said plainly that he can no longer tell what the harness does or why. When a change
  adds project config, a policy knob, or a new gate behaviour, either surface it in the
  dashboard in the same batch or file the UI card with it. Umbrella: **#138**.
- **`docs/FUTURE-BACKLOG.md` is FROZEN** (s52): do not append new items. Its open items
  were migrated to issues #85–#108, #110; the file remains as history plus the
  parked-by-design residuals it documents in place.

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
