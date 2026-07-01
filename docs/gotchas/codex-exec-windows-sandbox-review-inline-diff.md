# Codex-exec critic on Windows: sandbox can't spawn, so embed the diff inline

**Tag:** `[critic/codex]`
**Discovered:** s03 (2026-07-01), running the mandatory codex GPT-5.5 review gate.

## What happens

`codex exec -s read-only ...` on this Windows box **cannot spawn child processes** inside
its sandbox. When codex tries to explore the repo (run `Get-Content`, git, etc.) it errors:

```
ERROR codex_core::exec: exec error: windows sandbox: runner error:
  CreateProcessAsUserW failed: 5   (access denied)
```

There is also noise on unrelated startup paths (a `403 forbidden` on an MCP transport, and
`failed to parse plugin hooks config ... unknown field 'description'`) — harmless to the verdict.

## Why it doesn't break the review

If the **entire diff is embedded inline in the prompt** (not left for codex to read from disk),
codex still reasons over it and returns a valid, high-quality verdict. Across the s03 foundation
build it caught real defects every module (path-traversal, stdin-hang, UTF-8 corruption, dirty-tree
merge, string-based conflict false-positives). The sandbox failures only blocked codex's *optional*
self-exploration, not the review itself.

## How to apply

- Our review-gate command pipes a prompt on stdin that **contains the `git diff` verbatim** plus a
  strict output contract (`VERDICT: clean|defects` / numbered `DEFECTS`). Do NOT rely on codex opening
  files under `-s read-only` on Windows.
- This matches the parity spec §5 for the harness's own `critic-runner`: *"diff embedded inline (not
  read from disk by codex — avoids a second fencing surface)."* So the Windows sandbox limitation and
  the anti-anchoring fence point the same way — **always inline the diff**. Build the TS `codex-adapter`
  (plan Task 14) that way from the start.
- Ignore the `CreateProcessAsUserW failed: 5`, MCP `403`, and plugin-hook parse warnings in codex
  output — they do not invalidate a parsed verdict.

## Related
- `../superpowers/donor-extraction/autodev-loop-parity-spec.md` §5 — critic fencing / inline diff.
- `../superpowers/plans/2026-07-01-harness-p1-core-loop.md` — Task 12–14 (critic adapter).
