# `[detect/isolation-flags-not-orthogonal]`

**The `claude` extension-isolation flags are NOT cleanly orthogonal, and the
init-event `plugins` count is misleading — validated empirically (s28 probe C).**

`claude -p` init-event extension counts under each flag (baseline: 9 MCP / 46
skills / 78 slash / 11 agents):

| Flag | mcp | skills | slash | agents |
|---|---|---|---|---|
| `--strict-mcp-config` | **0** | 46 | 78 | 11 |
| `--disable-slash-commands` | 9 | **0** | **0** | 11 |
| `--bare` | **0** | 14 | 33 | 3 |
| all three | 0 | 0 | 0 | 3 |

Findings:

1. **`--strict-mcp-config`** (drop ambient MCP) and **`--disable-slash-commands`**
   (drop skills/slash) are the two CLEAN, orthogonal levers.
2. **`--bare` is NOT orthogonal** — it is the full **clean-room** (drops MCP,
   reduces skills to ~14 built-ins, agents to 3). There is **no** clean CLI flag
   for "plugins + hooks only". So do NOT model isolation as three independent
   checkboxes: expose `--bare` as a Clean-room MASTER that subsumes the other two
   (and grey them when it is on), plus the two orthogonal individual levers. This
   is why `workerIsolationFlags` returns `["--bare"]` alone for cleanRoom and never
   also emits `--strict-mcp-config`/`--disable-slash-commands` (redundant).
3. **The init `plugins` count stays at its full value even under clean-room** — it
   lists INSTALLED plugins, not ACTIVE ones. Never surface it as an "active
   extensions" metric; the honest live signals are `mcp_servers`, `skills`,
   `slash_commands`, and `agents`.

A live scan under clean-room therefore lands at `0 / 14 / 33 / 3` (built-ins
only), NOT `0 / 0 / 0 / 0` — expected, because the built-in skills/agents are not
the operator's ambient extensions. Found s28.

## Related
- `[[spawned-agents-inherit-ambient-extensions]]` — why the lever exists.
- `docs/superpowers/specs/2026-07-06-agent-extensions-isolation.md` — the spec (probe tables).
