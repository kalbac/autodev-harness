# Architecture Decision Records — Autodev Harness

> One decision per file. Immutable once accepted; supersede with a new ADR.

## Template

```markdown
# NNN — {Title}
**Status:** proposed | accepted | superseded by ADR-XXX
**Date:** DD.MM.YYYY
## Context
## Decision
## Consequences
## Related
```

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [001](001-fork-ao-not-wait.md) | Fork AO instead of waiting for upstream | superseded by ADR-002 |
| [002](002-build-own-harness-not-fork-ao.md) | Build our own harness; AO becomes one donor of several | accepted |
| [003](003-roles-are-a-configurable-vendor-matrix.md) | Roles are a configurable model matrix; the orchestrator is an in-harness LLM | accepted |
| [004](004-live-orchestrator-presence-and-post-review-autonomy.md) | Live orchestrator presence + post-review autonomy | accepted |
| [005](005-critic-is-a-correctness-gate-coverage-is-mechanical.md) | The critic is a correctness gate; coverage is the machine gate's job | accepted |
| [006](006-capability-based-authority-model.md) | Capability-based Authority Model — the worker never controls its own oracle | accepted |
