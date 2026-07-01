# Open Design — analysis & what to steal (UX/extensibility donor)

> Third donor tool for Autodev Harness. Analyzed 2026-07-01 against the live repo
> (not from memory). Sources at the bottom.
> Repo: `github.com/nexu-io/open-design` — Apache-2.0. A local-first, "open-source
> Claude Design alternative" desktop app (macOS/Windows).

## Why it's a donor even though its domain is design

Open Design *generates design artifacts* — irrelevant to us. But its **shell** is
exactly the harness UX we want: auto-detect local agents, a clean multi-pane UI, a
pluggable model layer, and first-class MCP / skills / plugins. We steal the **shell
and UX patterns**, not the design engine.

## Stack — and why it ports better than OpenHands

- **Frontend:** Next.js 16 App Router + React 18 + TypeScript.
- **Backend:** Node 24 · Express · SSE streaming · `better-sqlite3` (local-first).
- **Desktop:** **Electron** shell, sandboxed renderer, IPC-driven sidecar automation.
- **License:** Apache-2.0.

**AO is also Electron.** So Open Design's **UI/UX patterns transfer more directly**
than OpenHands' web canvas (though the frontend framework differs from AO's, so it's
still a *pattern* donor, not a raw code-merge). Apache-2.0 lets us copy code where a
port fits.

## What to steal — ranked (UX first, that's why the operator likes it)

| # | Steal | Why it fits us | Donor form |
|---|---|---|---|
| 1 | **PATH-scan agent auto-detection** — daemon discovers 22+ installed CLI agents (Claude Code, Codex, Cursor, Copilot, Gemini, Qwen, Kimi…) automatically; `od mcp install <agent>` deploys a stdio MCP server into each agent's config | **The feature the operator explicitly wants.** AO makes you pick `--harness` by hand. Auto-detecting what's installed is a big UX win + removes config friction. | pattern (reimplement in AO's Go/Electron) |
| 2 | **Three-tier UI blueprint** — *Entry* (pick skill + system + brief) → *Studio* (live preview + edit) → *Sidebar* (Home / Automation / Design System / **Plugins** / **Integrations**) | A proven, minimalist multi-pane layout. Adapt the sidebar to our domain: Home / **Board (kanban)** / Automation / **Skills** / **Integrations (MCP)**. Both are Electron. | UX pattern |
| 3 | **Model layer** — installed agents **+** AMR "official Model Router" (20+ models, zero-config) **+** BYOK proxy (`POST /api/proxy/{anthropic,openai,azure,google,ollama…}/stream`, SSE, SSRF-protected, any OpenAI-compatible endpoint) | Concrete engine for our **Tier-1 per-task model routing**. The proxy-per-provider + router pattern is exactly what we need. | pattern/architecture |
| 4 | **Extensibility trio: Skills + Plugins + Integrations** — Skills follow Claude Code's `SKILL.md` convention (extended frontmatter); Plugins need only a `SKILL.md` (+ `open-design.json` to list in the marketplace); Integrations page wires MCP + external systems | This is the "connect MCP, skills, connectors" the operator loves. Blueprint for making the harness **extensible** rather than hard-coded. | pattern |
| 5 | **Artifact Linting — a pre-emit 5-dimensional self-critique gate before delivery** | 🔑 Direct sibling of our "never merge bullshit": the **worker self-critiques before output**, *before* the independent critic even runs. Layer it under our GPT-5.5 gate as a cheap first pass. | pattern (high fit) |
| 6 | **Comment-Mode edits** — surgical, targeted modifications without full regeneration | How the critic feeds fixes back to a worker: targeted patch, not a full re-run. | pattern |
| 7 | **SSE streaming + `better-sqlite3` local-first persistence** — sandboxed `srcdoc` iframe preview | Implementation patterns for a responsive local-first UI + safe preview. | library/pattern |

## How the three donors now fit together

| Donor | Layer it feeds | Crown contribution |
|---|---|---|
| **AO** (base fork) | Body + UI + source of truth | kanban, session/PR supervision, worktree isolation |
| **autodev-loop** | Policy | independent GPT-5.5 critic gate, contract-zone guards, anti-drift |
| **OpenHands** | Intelligence patterns | event-stream trajectories, risk-based action confirmation, ACP, eval harness |
| **Open Design** | UX + extensibility | **agent auto-detection**, model router/BYOK, skills/plugins/MCP, UI blueprint, self-critique lint |

Open Design is the answer to *"how should the harness feel and extend?"* — the same
way autodev-loop answers *"how do we not merge bullshit?"*

## Open questions (verify before committing)

- What frontend framework does AO's Electron UI use? (decides how directly the
  three-tier layout + sidebar port.)
- PATH-scan detection: reuse Open Design's detection list/logic (Apache-2.0) or
  reimplement in AO's Go daemon?
- Adopt an AMR/BYOK-style proxy for model routing, or a thinner router over LiteLLM
  (OpenHands donor)? — converge these two before building Tier-1.

## Sources

- [Open Design GitHub (nexu-io/open-design)](https://github.com/nexu-io/open-design)

## Related

- `../VISION.md` — donor tools & single-source-of-truth rule.
- `openhands-analysis.md` — the intelligence-layer donor (event-stream, risk gating).
- `../CURRENT-STATE.md` → Tier-1 (per-task model routing, agent detection, UI).
- `../FUTURE-BACKLOG.md` — Open Design-derived candidate features.
