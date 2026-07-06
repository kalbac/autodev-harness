# `[agents/inherit-ambient-extensions]`

**The spawned worker (`claude -p`) and critic (`codex exec`) child CLIs inherit
the operator's FULL ambient extension set at runtime — global AND project.**

Established empirically in s28 (two live `claude -p` init-event probes + a code
trace). From a bare cwd with no project config, `claude -p --output-format
stream-json` loaded, from global `~/.claude`: **9 MCP servers, 46 skills, 78
slash-commands, 17 plugins, 11 subagents**, and fired the SessionStart hook. A
project `.mcp.json` in cwd auto-registered its server too (no `--mcp-config` /
approval in `-p` mode). Mechanism:

- **env passthrough** — `watchdog.ts` spawns with `env: process.env`; `native.ts`
  with `env: options.env ?? process.env`; nothing overrides `HOME`/`USERPROFILE`/
  `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. So global `~/.claude`/`~/.codex` resolve as in
  an interactive session.
- **cwd = the git worktree** (worker) — a plain `git worktree add` is a full
  checkout of tracked files, so a repo's committed `.claude/`/`.mcp.json`/
  `AGENTS.md` are present and loaded.
- **`-p` / `exec` do NOT skip extensions** — no suppression flag is passed;
  print/non-interactive mode still loads MCP + skills + plugins + subagents +
  hooks. codex likewise (gotcha `[critic/codex]` documents it auto-invoking its
  OWN skills in-sandbox).

**Consequence / why it matters.** Every worker task and critic run silently
carries the operator's entire personal Claude/Codex setup (telegram, obsidian,
supermemory, superpowers, …). That is a **reproducibility + surprise risk** for a
clean autonomous coder, not a feature. It also means a UI to *attach*
extensions to the agents is redundant — they already see everything.

**The lever (s28).** Per-project `isolation.worker.{cleanRoom,mcp,skills}` (OFF by
default → unchanged behavior) maps to real `claude` flags (see
`[detect/isolation-flags-not-orthogonal]`). The critic's NO-TOOLS preamble is
always-on in `buildCriticPrompt`. Inspect what an agent inherits via
`GET /projects/:id/agent-extensions` (the visibility scan). Found s28.

## Related
- `[[isolation-flags-not-orthogonal]]` — the flag semantics behind the lever.
- `docs/gotchas/codex-exec-windows-sandbox-review-inline-diff.md` — codex side.
- `docs/superpowers/specs/2026-07-06-agent-extensions-isolation.md` — the feature spec.
