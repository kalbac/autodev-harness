# Gotcha — OpenHands' real agent code lives in `software-agent-sdk`, not the main repo

**Tag:** `[donor/openhands]`
**Found:** 2026-07-01 (donor-extraction)

## The trap
Cloning `github.com/All-Hands-AI/OpenHands` and grepping for the event-stream, security
analyzer, ACP agent, or LiteLLM router **finds almost nothing useful.** The main repo is
now the **"Agent Canvas"** control-center shell (UI + HTTP backend); the actual agent
intelligence was extracted into a **separate repo, `github.com/OpenHands/software-agent-sdk`**,
and pulled back in as pinned PyPI packages (`pyproject.toml`).

## What to do
Study/verify OpenHands architecture against **`references/software-agent-sdk/`** (cloned,
pinned in `MANIFEST.md`), not `references/OpenHands/`. That is where `security/ensemble.py`,
`agent/acp_agent.py`, `event/.../action.py`, `llm/router/base.py` actually live.

## Why it matters
A donor study or codex verification pointed only at the main repo would wrongly conclude
"OpenHands doesn't have X" when X simply moved. Any future re-study must target the SDK.

## Related
- [[002-build-own-harness-not-fork-ao]]
- `docs/superpowers/donor-extraction/openhands-brief.md`
- `references/MANIFEST.md` — both clones + pinned SHAs.
