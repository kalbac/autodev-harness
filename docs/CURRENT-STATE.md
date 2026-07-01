# CURRENT STATE — Autodev Harness

> Update every session. Phase status, known issues, next actions.
> Last updated: 2026-07-01 (bootstrap session — project scaffolded).

## Phase

| Phase | Status |
|---|---|
| P0 — Bootstrap docs & charter | ✅ done (this session) |
| P1 — Clone AO source, scope Tier-1 | ⬜ **NEXT** |
| P2 — Fork hygiene setup (upstream remote, branch model) | ⬜ pending |
| P3 — Tier-1 build (`--model` spawn, scroll fix, critic column) | ⬜ pending |
| P4 — Tier-0 critic gate wired in practice | ⬜ pending |

## Last session (2026-07-01, bootstrap)

- Decided (with operator) to **fork AO** rather than wait — see `adr/001`.
- Named the project **Autodev Harness**; locked slogan + vision (`VISION.md`).
- Scaffolded the proven `docs/` structure; ported the two crown reference docs.
- Fork has **not** been cloned yet — that is the first engineering task.

## NEXT ACTIONS (do these when you open this project)

1. **Clone the AO source.** `git clone https://github.com/AgentWrapper/agent-orchestrator`
   into `D:\Projects\autodev-harness` (or a subdir). Confirm the actual repo URL/name
   — the CLI reports version `dev`; verify the org/name before cloning.
2. **Set up fork hygiene** (P2): add `upstream` remote, decide branch model so we can
   pull AO updates cleanly. Do this BEFORE writing any of our code.
3. **Scope Tier-1 with real numbers** — read the source and answer:
   - `--model` on `ao spawn`: where does spawn resolve the model? How big a change?
   - **Chat-scroll bug**: find the chat component in the Electron frontend; is it a
     CSS overflow / auto-scroll-pinning bug? Estimate the fix.
   - Critic verdict as a kanban column: how does the board read session state?
4. Write `adr/002-fork-hygiene-branch-model.md` once the branch strategy is chosen.

## Known issues to fix (from operator)

- 🐛 **Chat-scroll bug** in AO desktop UI — can't scroll back through chat history
  (operator loses earlier messages). Electron frontend. High-priority quality-of-life fix.
- ⚠️ AO has **no per-task model routing** — only a static per-project `--model`
  override. autodev-loop chose model by task complexity; we want that back.
- ⚠️ AO has **no critic-reviewer setting** — `ao review submit` only records a verdict;
  the critic (codex GPT-5.5) must be wired by us.

## Donor-tool analysis

- ✅ **OpenHands analyzed** (2026-07-01) → `wiki/openhands-analysis.md`. It's a
  **pattern donor** (Python+TS, MIT — ideas not code-merge). Top steals: risk-based
  action confirmation, event-stream trajectories, ACP-worker path, LiteLLM routing.
  Candidates parked in `FUTURE-BACKLOG.md`.
- ✅ **Open Design analyzed** (2026-07-01) → `wiki/opendesign-analysis.md`. UX/
  extensibility donor (Electron, Apache-2.0). Top steals: **PATH-scan agent
  auto-detection**, three-tier UI blueprint, model router + BYOK proxy, skills/
  plugins/MCP extensibility, pre-emit self-critique lint. Candidates in `FUTURE-BACKLOG.md`.
- Next donor-eval steps: (a) verify AO `--harness` ⇄ **OpenHands ACP** worker path;
  (b) identify **AO's frontend framework** (decides how directly Open Design's UI
  blueprint ports); (c) converge model-routing engine choice (BYOK-proxy vs LiteLLM);
  (d) **analyze Aider** (proposed 5th donor — worker edit quality/economy).

## Open questions

- Exact AO upstream repo URL/name + license (must confirm before forking).
- Electron frontend stack (framework? React/Svelte/vanilla?) — determines scroll-fix effort.
- Do we vendor our critic logic as a plugin, or patch the daemon directly? (fork-hygiene tradeoff)

## Related

- `VISION.md` — anchor. `adr/001-fork-ao-not-wait.md` — the fork decision.
- `reference/ao-codex-critic-protocol.md` — Tier-0 gate, ready to apply.
