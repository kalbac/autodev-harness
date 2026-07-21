# DOCS INDEX — Autodev Harness

> Navigation hub. Start here if you don't know where a thing lives.

## Read-first (every session)

| Doc | Purpose |
|---|---|
| `PRINCIPLES.md` | The invariants + *why* they exist (the constitution) — read before removing any guard |
| `VISION.md` | Mission anchor — slogan, single-source-of-truth rule, roles matrix |
| `CURRENT-STATE.md` | Live phase status, known issues, **NEXT ACTIONS** |
| `GOTCHAS.md` | Index of mistakes-to-avoid |

## Operational

| Doc | Purpose |
|---|---|
| `SESSION-LOG.md` | Full session history (newest on top) |
| `AGENT-RULES.md` | Workflow + coding rules for AI agents |
| `DOCS-SCHEMA.md` | Doc format + compilation protocol |
| `FUTURE-BACKLOG.md` | Deferred features / tech debt |

## Decisions & knowledge

| Dir / doc | Purpose |
|---|---|
| `adr/` | Architecture Decision Records (`adr/README.md` = template + index) |
| `wiki/` | **Architecture Notes — rationale (*why*, not API)** + deep-dive references |
| `wiki/architecture-review-external-2026-07.md` | External agent review — risks + priorities; seed for the Authority-Model → Profiles thrust |
| `wiki/authority-model-audit-2026-07.md` | Code audit (s48) — worker write-scope vs the oracle; what's sound, 4 holes, with file:line evidence; justifies `adr/006` |
| `wiki/openhands-analysis.md` | OpenHands analysis — intelligence-pattern donor, ranked "what to steal" |
| `wiki/opendesign-analysis.md` | Open Design analysis — UX/extensibility donor (agent auto-detect, model router, skills/plugins/MCP) |
| `gotchas/` | Atomic gotcha detail files |
| `archive/` | Resolved historical docs |

## Crown reference (what we are porting)

| Doc | Purpose |
|---|---|
| `reference/autodev-loop-runbook.md` | The proven autodev-loop design (critic prompt, contract zones, gate, escalation, anti-drift) |
| `reference/ao-codex-critic-protocol.md` | Tier-0 critic gate mapped onto AO's primitives — ready to apply |
