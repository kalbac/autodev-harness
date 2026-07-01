# Gotcha — the "AO chat-scroll bug" does not exist

**Tag:** `[ao/ui]`
**Found:** 2026-07-01 (donor-extraction, codex-verified A6)

## What we assumed
`VISION.md` / `CURRENT-STATE.md` / `SESSION-LOG s01` listed a **chat-scroll bug** in the
AO desktop UI (can't scroll back through history) as a known first target to fix.

## What is actually true
AO has **no custom chat UI at all.** The conversation *is* a tmux terminal rendered by
xterm.js, and the frontend deliberately sets `scrollback: 0`, delegating all scrolling to
tmux itself (`frontend` `XtermTerminal.tsx`, codex-verified). There is no
overflow/autoscroll-pinning bug to fix because there is no chat component.

## Why it matters
- Remove "fix AO chat-scroll bug" from any target list — it's chasing a ghost.
- For our own web UI (P2) we design autoscroll/scrollback **from scratch**; there is no AO
  implementation to port or repair here.

## Related
- [[002-build-own-harness-not-fork-ao]] — AO is now a donor, not the base.
- `docs/superpowers/donor-extraction/ao-brief.md` — evidence.
