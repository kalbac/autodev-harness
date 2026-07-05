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
- **s26 wrinkle — codex can STALL trying to spawn its OWN plugins/skills, not just your review commands.**
  A newer codex CLI (v0.142.x) auto-selects installed skills (`coderabbit:code-review`,
  `superpowers:using-superpowers`) and tries to `Get-Content` their `SKILL.md` via pwsh at turn start —
  each spawn hits the sandbox and errors `orchestrator_helper_exit_nonzero: setup helper exited with
  status Some(-1073741502)` (STATUS_DLL_INIT_FAILED). Run **in the background** and it can loop on these
  failures and get killed before ever emitting a verdict (happened twice this session: two `run_in_background`
  codex runs came back `killed` with only the prompt echoed, no findings). **Fix: prepend a hard NO-TOOLS
  preamble** — *"Do NOT run any shell command, read any file, or invoke any skill/plugin/MCP tool;
  subprocess spawning is blocked by the sandbox; the COMPLETE diff is inline below; review from it and
  respond directly."* With the diff already inline codex needs no tools, answers in ONE turn, and a
  **foreground** run (timeout ~7 min) returns a clean verdict fast (~8k–20k tokens). Inline diff + no-tools
  preamble + foreground is the reliable recipe on this box.

## Related
- `../superpowers/donor-extraction/autodev-loop-parity-spec.md` §5 — critic fencing / inline diff.
- `../superpowers/plans/2026-07-01-harness-p1-core-loop.md` — Task 12–14 (critic adapter).
