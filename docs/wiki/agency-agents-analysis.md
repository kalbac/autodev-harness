# agency-agents — analysis & 5-way verdict

> The operator's "competitor" candidate. Analyzed 2026-07-07 (s32) against the live
> shallow clone (not from memory), mapped onto our anchors in `../VISION.md`.
> Repo: `github.com/msitarzewski/agency-agents` — MIT, active/mature (as a content project).

## TL;DR verdict

**#4 — Not for us** (as a competitor or an architectural donor): it shares **none** of
our hard problems (critic gate, worktree isolation, blackboard/queue, merge discipline).
It is **not redundant** with autodev — it does not do what we do; it is a layer *above*
us. One small **#2 (adopt-alongside)** footnote survives: it is a free MIT **content
library** of persona prompts we could cherry-pick from — see the worker-persona-catalog
idea in `../FUTURE-BACKLOG.md`.

## What it actually is

A curated **library of AI agent persona/prompt files** ("The Agency"), NOT an
orchestrator or a harness. Concretely (from the clone):

- **~280 markdown agents** across 17 "divisions" (engineering 36, marketing 36,
  security 10, design/testing 9, …). 283 `.md` vs only 9 shell + 1 python — it is a
  *content* repo, not a *runtime* repo.
- Each agent = one `.md`: frontmatter (`name`/`description`/`color`/`emoji`/`vibe`) + a
  personality/mission/deliverables prompt body ("You are Frontend Developer …").
- **Distribution, not execution:** `scripts/convert.sh` transforms one definition into
  ~15 tools' formats; `scripts/install.sh` copies them into each tool's config dir
  (Claude Code `~/.claude/agents/`, Cursor `.cursor/rules/`, Codex `~/.codex/agents/`,
  Gemini, OpenCode, Aider, Windsurf, Copilot, Qwen, Osaurus, …).
- A separate native **desktop app** (`agency-agents-app`, macOS/Linux/Windows) browses
  the roster and one-click-installs personas — a *catalog installer*, not a run supervisor.
- **License MIT.** Maturity is real but *content-side*: i18n, CI checks
  (check-divisions / lint-agents / originality), SECURITY.md, ~684 PRs.

**The decisive fact:** it does not *run* agents at all — it lays down prompt files that
a host tool (Claude Code, Cursor, …) later executes. It operates one layer above the
harness.

## Mapped against our VISION anchors

| Our pillar | agency-agents |
|---|---|
| Independent critic gate ("never merge bullshit") | ❌ none — zero review discipline |
| Worktree isolation | ❌ |
| File-blackboard / queue / state | ❌ |
| Conductor / run loop | ❌ |
| Web UI for run supervision | ❌ (their app installs a catalog; it does not supervise runs) |
| Merge / commit discipline | ❌ |

Overlap on the harness axis is **~zero**. The only tangential touch points: (a) it
enumerates the same universe of agentic CLIs we PATH-detect since s26
(claude/codex/cursor/aider/opencode/gemini/qwen…); (b) its desktop app is a catalog GUI,
superficially near our "installed agents" awareness — but as an *installer*, not a *runner*.

## The 5-way frame (operator's)

1. **Redundant?** No — different problem (persona distribution), can't replace autodev,
   fixes none of our bugs.
2. **Adopt-alongside?** Weakly, optionally — a free MIT persona-prompt library; usable as
   a *content source* for worker personas, independent of the harness. Not a dependency.
3. **New reference (donor to graft)?** Marginal — only its `convert/install`
   one-definition→15-formats matrix is engineeringly neat, and only relevant IF we ever
   distribute personas ourselves. Nothing on the critic/gate/isolation axis (where
   AO/OD/OpenHands remain our references).
4. **Not for us?** Yes — the honest core: a different category of tool.
5. **Something else (our read)?** The promt called it a "competitor"; it is in fact
   **orthogonal** — not a competitor at all.

## The one thing worth keeping (footnote #2)

The persona library is a usable **content source**. Several personas map straight onto
the operator's own projects — e.g. `engineering/engineering-wordpress-shopping-cart.md`
and `engineering-drupal-shopping-cart.md` are directly relevant to the woodev /
woocommerce work. This seeds a deferred idea: **a worker-persona catalog** for the harness
(pick a specialist persona per task/project to prime the worker), parked in
`../FUTURE-BACKLOG.md`. It changes nothing on the roadmap now — our differentiator is the
gate, not persona breadth — but it is a cheap future lever.

## Sources

- [agency-agents GitHub](https://github.com/msitarzewski/agency-agents) — MIT
- [Agency Agents app](https://github.com/msitarzewski/agency-agents-app) · [agencyagents.app](https://agencyagents.app)

## Related

- `../VISION.md` — donor tools & single-source-of-truth rule.
- `../FUTURE-BACKLOG.md` — the worker-persona-catalog idea seeded here.
- `openhands-analysis.md`, `opendesign-analysis.md` — the actual harness-axis donors.
