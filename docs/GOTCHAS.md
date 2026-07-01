# GOTCHAS — Autodev Harness

> Index of mistakes-to-avoid. Each entry → atomic detail file in `gotchas/{slug}.md`.
> Scan the relevant tags before starting related work.
> Count: 2.

| Tag | Gotcha | Detail |
|-----|--------|--------|
| `[ao/ui]` | The "AO chat-scroll bug" is a phantom — AO has no chat UI (tmux terminal, `scrollback:0`). Nothing to fix. | `gotchas/ao-chat-scroll-bug-is-a-phantom.md` |
| `[donor/openhands]` | OpenHands' real agent code lives in `software-agent-sdk`, not the main repo — study the SDK clone. | `gotchas/openhands-real-code-is-in-software-agent-sdk.md` |

## Anticipated tag namespaces

- `[fork/*]` — fork-hygiene / upstream-merge pitfalls
- `[ao/*]` — AO daemon/CLI behaviours
- `[electron/*]` — AO desktop UI internals
- `[critic/*]` — critic-gate wiring pitfalls
