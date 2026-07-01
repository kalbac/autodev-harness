# GOTCHAS — Autodev Harness

> Index of mistakes-to-avoid. Each entry → atomic detail file in `gotchas/{slug}.md`.
> Scan the relevant tags before starting related work.
> Count: 4.

| Tag | Gotcha | Detail |
|-----|--------|--------|
| `[ao/ui]` | The "AO chat-scroll bug" is a phantom — AO has no chat UI (tmux terminal, `scrollback:0`). Nothing to fix. | `gotchas/ao-chat-scroll-bug-is-a-phantom.md` |
| `[donor/openhands]` | OpenHands' real agent code lives in `software-agent-sdk`, not the main repo — study the SDK clone. | `gotchas/openhands-real-code-is-in-software-agent-sdk.md` |
| `[critic/codex]` | `codex exec` sandbox can't spawn subprocesses on Windows (`CreateProcessAsUserW failed: 5`) — embed the diff inline in the prompt and it reviews fine. | `gotchas/codex-exec-windows-sandbox-review-inline-diff.md` |
| `[critic/codex]` | `critic-verdict.schema.json` is not copied to `dist/` by `tsc` — the critic's `--output-schema` path breaks from a compiled build (works from source). Dist-copy deferred to Task 29. | `gotchas/critic-schema-json-not-copied-to-dist.md` |

## Anticipated tag namespaces

- `[fork/*]` — fork-hygiene / upstream-merge pitfalls
- `[ao/*]` — AO daemon/CLI behaviours
- `[electron/*]` — AO desktop UI internals
- `[critic/*]` — critic-gate wiring pitfalls
