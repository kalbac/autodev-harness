# FUTURE BACKLOG — Autodev Harness

> Deferred features and tech debt. Not scheduled; parked with rationale.

## Deferred features

- **Tier-2: native critic-gate concept in AO** — model the critic verdict + gate as
  first-class daemon state, not just `ao review submit`. Deferred until Tier-1 proves
  the fork is worth deepening.
- **Tier-2: model-by-complexity router in the UI** — let the operator see/tune the
  complexity→model mapping. Depends on Tier-1 `--model` landing first.
- **Contract-zone guards as native concept** — port autodev-loop's mutation-verified
  guard registry (`GUARDS.md`) into the harness so the gate can auto-bless contracts.
- **Anti-drift critic** — periodic "intent vs diff" check (runbook §7). High value,
  but needs the basic critic gate working first.
- **Escalation → Telegram** — reuse autodev-loop's structured escalation format.

## Tech debt / risks to watch

- **Upstream merge debt** — the standing risk of any fork. Revisit branch model if
  pulling AO updates starts to hurt.
- **Two-provider critic dependency** — the gate needs codex (GPT-5.5) available;
  define graceful behaviour when it's down (park, don't silent-pass).

## Related

- `VISION.md` → tier plan. `CURRENT-STATE.md` → what's actually next.
