# Spec — Agent extensions: visibility + isolation (Web-UI item 4, s28)

> Status: APPROVED (operator, s28 2026-07-06). Supersedes the original "attach
> skills/plugins/MCP" framing of Web-UI item (4).

## Why (the s28 investigation)

An Explore recon + two live `claude -p` probes established **empirically** that the
spawned worker and critic child CLIs **inherit the operator's full ambient
extension set** — both global (`~/.claude`, `~/.codex`) and project
(`.claude/`, `.mcp.json`, `AGENTS.md` in the worktree):

- Worker `claude -p` in a bare cwd loaded **9 MCP servers, 46 skills, 78
  slash-commands, 17 plugins, 11 subagents**, and fired the SessionStart hook —
  all from global `~/.claude`. A project `.mcp.json` in cwd auto-registered its
  server too (no `--mcp-config`/approval needed in `-p` mode).
- env is passed through unmodified (`watchdog.ts` `env: process.env`;
  `native.ts` `env: options.env ?? process.env`); no `HOME`/`CLAUDE_CONFIG_DIR`/
  `CODEX_HOME` override anywhere. cwd (worker) = the per-task git worktree, which
  carries the repo's tracked config.
- codex critic likewise inherits `~/.codex` + project config; the gotcha
  `[critic/codex]` documents it auto-invoking its OWN skills/plugins in-sandbox
  (the reason for the manual NO-TOOLS preamble).

So an "attach extensions" UI is **redundant** (the agents already see everything).
The real unmet need is the OPPOSITE: **visibility** ("what do my agents inherit?")
+ **isolation** ("run them clean / reproducible").

## Isolation flag semantics (empirically validated, probe C)

`claude -p` init-event extension counts under each flag (baseline 9 mcp / 46 skills / 78 slash / 11 agents):

| Flag | mcp | skills | slash | agents |
|---|---|---|---|---|
| `--strict-mcp-config` | **0** | 46 | 78 | 11 |
| `--disable-slash-commands` | 9 | **0** | **0** | 11 |
| `--bare` | **0** | 14 | 33 | 3 |
| all three | 0 | 0 | 0 | 3 |

Findings that shape the design:
- `--strict-mcp-config` and `--disable-slash-commands` are **clean, orthogonal**
  levers (MCP-only / skills-only).
- `--bare` is **not** orthogonal — it is the full **clean-room** (also drops MCP,
  reduces skills to ~14 built-ins, agents to 3 built-ins). There is **no** clean
  CLI flag for "plugins+hooks only".
- The init `plugins` array stays 17 even under clean-room (it lists INSTALLED, not
  ACTIVE plugins) → **do not** surface plugin count as an "active" metric. Honest
  signals = `mcp_servers`, `skills`, `slash_commands`, `agents`.

## Design

### Config (`.autodev/config.yaml`) — OFF by default (backward-compatible)

New top-level block; all booleans default `false` (→ byte-identical current spawn):

```yaml
isolation:
  worker:
    cleanRoom: false   # --bare (master; drops everything ambient). When true,
                       # mcp/skills are subsumed (do not also emit their flags).
    mcp: false         # --strict-mcp-config (ignored when cleanRoom)
    skills: false      # --disable-slash-commands (ignored when cleanRoom)
```

Critic isolation needs no toggle — the NO-TOOLS preamble is now ALWAYS-ON in code.

### Effective worker flags (pure helper, unit-tested)

`workerIsolationFlags(cfg): string[]`
- `cleanRoom` → `["--bare"]` (and NOT `--strict-mcp-config`/`--disable-slash-commands`; `--bare` covers them).
- else: `mcp` → push `--strict-mcp-config`; `skills` → push `--disable-slash-commands`.
- appended to the existing `claude -p …` arg array in `ClaudeWorkerAdapter.run`.

### Critic NO-TOOLS preamble (always-on)

`buildCriticPrompt` gains a prominent early section (verbatim intent from gotcha
`[critic/codex]`): "Do NOT run any shell command, read any file, or invoke any
skill/plugin/MCP tool. Subprocess spawning is blocked / unnecessary. The COMPLETE
diff is inline below — review from it and respond directly." Every existing
prompt-content test updates. Closes the docs-vs-code gap.

### Projection + write path

- `buildProjectConfigView` adds `isolation: { worker: {cleanRoom, mcp, skills} }`
  (read-only, always projected — plain booleans, no exactOptional gymnastics).
- `ScaffoldFormSchema` + `buildConfigYaml` + `mergeConfigYaml` accept
  `isolation.worker.{cleanRoom,mcp,skills}` (strict; mirrors the roles write path).

### Visibility scan endpoint (M1b)

`GET /agents/extensions?cwd=<project repoRoot>&…isolation flags…` (daemon-global,
admin-gated, mirrors `GET /agents/detect`). Spawns the real `claude` with
`-p --model <ladder[0]> --permission-mode acceptEdits --max-turns 1 --verbose
--output-format stream-json` + the effective isolation flags + a trivial stdin
prompt; **streams stdout, captures the first `system/init` event, then KILLS the
child** (SIGTERM→SIGKILL deadline) before any model turn — zero model cost.
Returns `{ model, cwd, mcp: [{name,status}], skills: string[], slashCommands:
string[], agents: string[] }`. Pure logic behind an injectable `probeInit` dep
(testable without spawning), same shape as `detectAgents`' `probeVersion`.
Best-effort/never-throws.

Codex side: no clean init JSON — MVP shows a static honest note ("codex inherits
~/.codex global + project AGENTS.md; NO-TOOLS preamble enforced"), no live probe.

### UI (M2, review-only)

Project Settings → new "Agent extensions" section:
- **Isolation** controls: a "Clean-room" master toggle (`cleanRoom`) + two
  individual toggles MCP / Skills (disabled/greyed when Clean-room is on).
  Wire into `buildDiff` send-only-changed (mirror the roles pattern).
- **Visibility**: a "Scan" button (like s26 "Rescan") → `GET /agents/extensions`
  with the currently-saved isolation → renders the inherited set (mcp/skills/
  slash/agents counts + names). Reflects the EFFECTIVE (post-isolation) picture.

## Module plan / gate discipline

- **M1a** (backend, codex-gated): schema + `workerIsolationFlags` + adapter wiring
  + critic preamble + config-view + scaffold write. Enforcement-adjacent (worker
  spawn + critic prompt) → full independent codex GPT-5.5 gate + re-critic.
- **M1b** (backend, codex-gated): scan endpoint (spawn+init-parse+kill) + admin
  port method + route. Spawns the real CLI → codex-gated.
- **M2** (UI, review-only): the Settings section + `api.ts` mirror; browser-proof.

## Verification

Root `npm run typecheck` + `cd ui && npm run typecheck`; full vitest suite green
(currently 737). Live-smoke: seed a scratch project, serve, toggle isolation, hit
the scan endpoint, confirm the effective counts drop as the probe table predicts.

## Related
- `docs/gotchas/codex-exec-windows-sandbox-review-inline-diff.md` — the NO-TOOLS evidence.
- `docs/CURRENT-STATE.md` — s28 NEXT ACTIONS.
