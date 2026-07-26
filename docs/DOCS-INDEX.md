# DOCS INDEX — Autodev Harness

> Navigation hub. Start here if you don't know where a thing lives.

## Read-first (every session)

| Doc | Purpose |
|---|---|
| `VISION.md` | Mission anchor — slogan, single-source-of-truth rule, roles matrix |
| `PRINCIPLES.md` | The 15 invariants + *why* they exist (the constitution) — read before removing any guard |
| `../AGENTS.md` | The agent contract for this repo — language, git ownership, batch merges, review discipline, backlog |
| `CURRENT-STATE.md` | Live phase status, known issues, **NEXT ACTIONS** |
| `GOTCHAS.md` | Index of mistakes-to-avoid → `gotchas/{slug}.md` |

## Operational

| Doc | Purpose |
|---|---|
| `SESSION-LOG.md` | Full session history (newest on top) — where all shipping detail lives |
| `AGENT-RULES.md` | Workflow + coding rules for AI agents |
| `DOCS-SCHEMA.md` | Doc format + compilation protocol (what goes where, and why not to duplicate) |
| `FUTURE-BACKLOG.md` | **FROZEN** — history + parked-by-design residuals; the live backlog is GitHub Issues + board #2 |
| `../CLAUDE.md` | Session start/end protocol, coding conventions, MCP tools |
| `../README.md` | The public face of the project |

## Decisions & knowledge

| Dir / doc | Purpose |
|---|---|
| `adr/` | Architecture Decision Records (`adr/README.md` = template + index) |
| `wiki/` | **Architecture Notes — rationale (*why*, not API)** + deep-dive references |
| `gotchas/` | Atomic gotcha detail files (one mistake each) |
| `superpowers/` | Working artifacts of the brainstorm→spec→plan cycle — `specs/`, `plans/`, `donor-extraction/`; heavily linked from ADRs and SESSION-LOG |

### `wiki/` contents

| Doc | Purpose |
|---|---|
| `architecture-review-external-2026-07.md` | External agent review — risks + priorities; seed for the Authority-Model → Profiles → reports → corpus chain (now shipped end to end) |
| `authority-model-audit-2026-07.md` | Code audit (s48) — worker write-scope vs the oracle; what's sound, 5 holes, with file:line evidence; justifies `adr/006` |
| `critic-model-calibration-s44.md` | How the critic model was chosen — methodology + results; **re-run this set before promoting any future critic model** |
| `component-currency-audit-s35.md` | UI components audited against the live shadcn catalog |
| `agent-ci-analysis.md` | `@redwoodjs/agent-ci` as a gate step — capabilities and limits |
| `agency-agents-analysis.md` | Agent-framework survey |
| `openhands-analysis.md` | OpenHands — intelligence-pattern donor, ranked "what to steal" |
| `opendesign-analysis.md` | Open Design — UX/extensibility donor (agent auto-detect, model router, skills/plugins/MCP) |

## Crown reference (what we ported)

| Doc | Purpose |
|---|---|
| `reference/autodev-loop-runbook.md` | The proven autodev-loop design (critic prompt, contract zones, gate, escalation, anti-drift) |
| `reference/ao-codex-critic-protocol.md` | Tier-0 critic gate mapped onto AO's primitives |

## Related

- `DOCS-SCHEMA.md` — the format rules this index is organized by.
- `CURRENT-STATE.md` — what to do next, concretely.
- `VISION.md` — why any of this exists.
