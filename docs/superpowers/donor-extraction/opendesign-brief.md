# Donor Extraction Brief — Open Design

**Target:** `D:/Projects/autodev-harness/references/open-design/` (clone, ~10k files)
**Repo identity:** `github.com/nexu-io/open-design` — Electron desktop app (macOS/Windows) wrapping a Node/TS daemon (`apps/daemon`, the `od` binary) + a Next.js/React web UI (`apps/web`), local-first, SQLite-backed. Product: agentic design workspace that drives *external* code-agent CLIs (Claude Code, Codex, Cursor, Gemini, etc.) rather than reimplementing its own agent loop.

## License

`LICENSE` = **Apache License 2.0** (`D:/Projects/autodev-harness/references/open-design/LICENSE:1-3`). Permissive — code reuse (not just ideas) is legally fine, including verbatim porting of modules, provided attribution/NOTICE conventions are respected if we ever redistribute. No copyleft constraint on autodev-harness.

---

## Axis 1 — STATE MODEL

**Hybrid: SQLite metadata index + filesystem-owned project content.**

- `apps/daemon/src/db.ts:1-45` — `better-sqlite3`, WAL mode, FK constraints on. Comment at the top is explicit about the split: *"the on-disk project folder under `.od/projects/<id>/` is still the single owner of the user's actual files (HTML artifacts, sketches, uploads); this database tracks the metadata that used to live in localStorage."*
- `openDatabase(projectRoot, {dataDir})` (`db.ts:32`) resolves `<dataDir>/app.sqlite` (or `<projectRoot>/.od/app.sqlite`), runs `migrate(db)` which also delegates to per-feature migration functions imported from sibling modules (`migrateCritique`, `migrateMediaTasks`, `migrateLibrary`, `migratePlugins` — `db.ts:11-14`). Each subsystem owns its own tables/migration, composed into one `migrate()` call — a clean pattern for a modular blackboard schema.
- Root `AGENTS.md` codifies a **"Daemon data directory contract"**: exactly one truth source (`RUNTIME_DATA_DIR`, resolved once in `server.ts` from `OD_DATA_DIR`), all daemon-owned paths (SQLite, artifacts, MCP config, plugin state, agent runtime homes, logs) must derive from it, agent subprocesses inherit it via `OD_DATA_DIR` env instead of re-deriving their own. This is a strong "single source of truth for state root" discipline.

**Verdict: 🟡 GRAFTABLE-LATER.** Not architecture-shaping for us (we've already decided file-based blackboard), but the "SQLite as a queryable index over a filesystem the agent also touches directly" pattern, and the *centralized data-root contract with one resolution point*, are worth stealing wholesale for our own blackboard once path conventions are frozen.

---

## Axis 2 — WORKER-BACKEND INTERFACE (PATH-scan agent auto-detection) — TOP EXPECTED STEAL

This is the best-evidenced, most load-bearing subsystem in the repo.

### Design doc
`docs/agent-adapters.md:7-12` states the thesis directly: *"We delegate the entire agent loop — model calls, tool use, context management, permission handling, resume, cancel — to the user's existing code agent CLI. OD's job is to detect it, feed it a skill + prompt + working directory, and stream its output back to the web UI."* Explicitly credits inspiration: **multica** (PATH-scan detection + daemon architecture) and **cc-switch** (per-agent config format knowledge + symlink-based skill distribution) — `docs/agent-adapters.md:9`.

### Real code (not just the doc)
- **Registry of adapters:** `apps/daemon/src/runtimes/registry.ts:1-55` — a flat array `BASE_AGENT_DEFS` of 24 statically-imported `RuntimeAgentDef` objects (`claude`, `codex`, `devin`, `gemini`, `opencode`, `hermes`, `trae-cli`, `grok-build`, `kimi`, `cursor-agent`, `qwen`, `qoder`, `copilot`, `amp`, `pi`, `kiro`, `kilo`, `vibe`, `deepseek`, `aider`, `antigravity`, `reasonix`, `codebuddy`, `mimo`, plus `amr` for their own cloud router), each in its own file under `apps/daemon/src/runtimes/defs/*.ts`. `AGENT_DEFS` also merges in user-defined local profiles (`readLocalAgentProfileDefs`, `registry.ts:57-66`) — i.e. users can register their own CLI adapter via a local JSON profile without a code change. Duplicate-id detection throws at module load (`registry.ts:68-74`).
- **PATH scan mechanics:** `apps/daemon/src/runtimes/executables.ts`
  - `resolvePathDirs()` (`executables.ts:97-112`) = `process.env.PATH` split on `path.delimiter`, **plus** `userToolchainDirs()` — a platform-aware list of well-known user toolchain bins (Homebrew, `~/.local/bin`, `~/.bun/bin`, npm-global prefixes, Node version-manager dirs) sourced from `@open-design/platform`'s `wellKnownUserToolchainBins`. This exists specifically because *"GUI launchers (macOS .app bundles, Linux .desktop files) often start with a minimal PATH"* (`executables.ts:101-104`) — i.e. a `.app` bundle doesn't inherit the user's shell PATH, so PATH-scan alone is insufficient and must be supplemented.
  - `resolveOnPath(bin)` (`executables.ts:130-143`) walks every dir × every `PATHEXT` extension on Windows (`.EXE;.CMD;.BAT`) or a single empty ext on POSIX, `existsSync` per candidate.
  - `inspectAgentExecutableResolution(def, configuredEnv)` (`executables.ts:318-354`) layers **four** resolution sources in priority order: (1) explicit `*_BIN` env override (`AGENT_BIN_ENV_KEYS` map, `executables.ts:16-39`, e.g. `CLAUDE_BIN`, `CODEX_BIN`), (2) a packaged built-in binary bundled with the app (AMR only), (3) PATH-resolved `def.bin` or any of `def.fallbackBins` (fork/rebrand support — e.g. Claude Code forks shipping as a different binary name), (4) last-resort platform-specific bundle probing (macOS `.app` bundle interior paths for Codex, `codexAppBundleExecutable`, `executables.ts:280-309`, because the official Codex.app doesn't add itself to PATH unless the user runs "Install command line tool").
  - Sandbox isolation: `resolveDetectionHome()` (`executables.ts:50-58`) honors an `OD_AGENT_HOME` override so sandboxed/test detection never leaks the real machine's PATH/home — used by their own test suite for deterministic detection tests.
- **Probe pipeline:** `apps/daemon/src/runtimes/detection.ts`
  - `probe(def, configuredEnv)` (`detection.ts:191-257`): resolves launch path → spawns `--version` with a 3s default timeout (`probeVersionAtPath`, `detection.ts:117-146`, classifies OS-level EACCES/ENOENT vs "spawned but unhappy" so Settings can show precise remediation) → **concurrently** runs three independent post-version probes (`Promise.all`, `detection.ts:231-235`): `--help` capability-flag scan (`probeCapabilities`, caches which optional CLI flags are supported), model-list fetch (`fetchModels`, live CLI query with static fallback), and auth-status probe (`probeAgentAuthStatus`). This drops wall-clock detection time to `max(help, models, auth)` instead of the sum.
  - `detectAgents()` / `detectAgentsStream()` (`detection.ts:323-363`) run all 24+ adapter probes in parallel with per-adapter fault isolation (`safeProbe`, `detection.ts:289-305`) — one adapter's synchronous throw during PATH walking must not zero out the whole picker (explicit regression fix referenced: issue #2297). The streaming variant yields each `DetectedAgent` in completion order via `Promise.race` over a pending set, so the UI paints agent cards as they resolve rather than waiting for the slowest CLI (`detectAgents.ts:346-363`).
- **Two-signal confidence model** (per `docs/agent-adapters.md:80-89`): PATH scan (fast, <10ms) + config-dir probe (`~/.claude/`, `~/.codex/`, etc.) — if only one signal fires, `authState` is marked `"missing"` and the user is prompted to run the CLI's auth flow rather than silently hiding the agent.

### Is the agent-backend a pluggable adapter? — Yes, cleanly.
`RuntimeAgentDef` (`apps/daemon/src/runtimes/types.ts`, referenced throughout) is a declarative object per adapter: `id`, `bin`, `fallbackBins`, `versionArgs`, `helpArgs`/`capabilityFlags`, `listModels`/`fetchModels`, `buildArgs`, `promptInputFormat` (`'text'` vs `'stream-json'`), `streamFormat`, `env`. New adapters are added by dropping a new `defs/<id>.ts` file and registering it in `registry.ts` — no changes needed to `detection.ts`, `executables.ts`, or the UI. The interface is documented top-level in `docs/agent-adapters.md:22-71` as `AgentAdapter { detect(), capabilities(), run(), cancel(), resume?() }` — the doc's interface is slightly idealized vs. the real (more pragmatic, less OOP) `RuntimeAgentDef` shape, but the seam boundaries match 1:1.

### Verdict: 🔴 ARCHITECTURE-SHAPING.
This is the single highest-value steal in the repo, exactly matching our own worker-backend interface need (`claude -p` / `codex exec` today, more CLIs later). Decide *before freeze*:
1. Adopt the **layered resolution order** (explicit env override → packaged binary → PATH+toolchain-dir scan → platform bundle probe) — this alone would have saved us from GUI-launcher-minimal-PATH bugs.
2. Adopt the **declarative per-adapter def file + flat registry array** shape over a class-hierarchy adapter pattern — it stays trivially greppable and testable in isolation.
3. Adopt **parallel + fault-isolated + streamed** detection (`safeProbe` + `Promise.race` completion order) — directly reusable for our own "which CLIs are installed" health check at daemon start.
4. Note the **`userToolchainDirs()` gap-filler** — critical if we ever ship a GUI wrapper (Electron/Tauri) since GUI-launched processes get a stripped PATH on macOS/Linux; a pure PATH-scan (`which`) is not sufficient by itself.

---

## Axis 3 — CHECKPOINT (resume / interrupt)

Present and real, not a stub — contradicts the "n/a likely" assumption.

- `apps/daemon/src/agent-session-resume.ts:1-50+` implements a **resume-identity guard**: a stored upstream CLI session id (Claude Code / Codex / ACP session) is only resumed if model, cwd, and conversation shape are unchanged since the session was captured. `ResumeInvalidationReason` enum: `model_changed | cwd_changed | conversation_advanced | missing_cursor` (`agent-session-resume.ts:19-24`). On any mismatch the daemon reseeds the **full transcript** into a fresh session rather than resuming — i.e. correctness over cheap continuation.
- Session records persisted via `db.ts` (`getAgentSessionRecord` / `upsertAgentSession` / `clearAgentSession`), so resume state survives daemon restarts.
- The Critique Theater orchestrator (see Axis 5) separately supports interrupt/cancel with best-effort flush: `apps/daemon/src/critique/orchestrator.ts` accepts an `AbortSignal` and *"flushes best-so-far state and emit `critique.interrupted` before returning"* (`orchestrator.ts:87-89`).

**Verdict: 🟡 GRAFTABLE-LATER.** The "compare identity fingerprint (model+cwd+conversation-cursor), invalidate and reseed rather than silently resume a stale session" pattern is a good, low-risk idea for our own worker checkpointing once we have multi-turn resumable runs.

---

## Axis 4 — WORKER ISOLATION

**Process-level only — env/HOME redirection, no OS-level sandbox.**

- `apps/daemon/src/sandbox-mode.ts:1-195` — `OD_SANDBOX_MODE` env flag gates a `SandboxRuntimeConfig` that redirects `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `NPM_CONFIG_USERCONFIG`, etc. to a synthetic directory tree under the daemon's data root (`applySandboxRuntimeEnv`, `sandbox-mode.ts:162-195`). This is genuinely useful for **deterministic tests and avoiding cross-contamination between agent CLI configs**, and for scoping imported-project roots to an allowlist (`isSandboxImportedProjectRootAllowed`, `sandbox-mode.ts:87-94`, path-containment check via `realpathSync.native` + `path.relative`).
- Explicitly **not** container/VM/seccomp isolation: `grep -rli "seccomp|firejail|bubblewrap|gvisor|landlock"` across `apps/daemon/src` returns nothing except an incidental Codex-related string; `grep -rli docker` returns only two unrelated files (`plugins/atoms/handoff.ts`, `server.ts`). Agent CLIs run as plain child processes (`node:child_process.spawn`) on the host with a real, unrestricted filesystem/network — the sandbox is a *config/env jail*, not a *security boundary*.

**Verdict: 🟡 GRAFTABLE-LATER, with an explicit caveat to flag as an anti-pattern.** The env-redirection trick is worth stealing for test isolation (`OD_AGENT_HOME` override pattern also feeds directly into the PATH-scan detection code — Axis 2 — so it's a twofer). But if our threat model requires real worker isolation (untrusted agent code, blast-radius containment), Open Design's approach is **not sufficient on its own** — do not copy it as "the isolation story," only as the config-jail layer underneath a real sandbox (container/VM) we add ourselves.

---

## Axis 5 — GATE LEVEL (pre-emit self-critique)

**"Critique Theater" / "Design Jury" — a genuine, implemented multi-panel critique gate. This is a second major steal candidate.**

- `docs/critique-theater.md:1-120` — five fixed panelists (Designer, Critic, Brand, Accessibility, Copy) score every emitted `<artifact>` block across rounds, in the **same CLI session/transport as the agent itself** (turns separated by `<PANELIST role="...">` tags, not separate subprocesses) — explicitly to avoid *"the panelist disagrees with itself across processes"* failure mode (`critique-theater.md:29-33`).
- Weighted composite: `composite = designer×0.0 + critic×0.4 + brand×0.2 + a11y×0.2 + copy×0.2`, threshold 8.0/10, up to 3 auto-converging rounds, `fallbackPolicy` (`ship_best` by default) if no round clears the bar (`critique-theater.md:44-64`).
- **Real code**, not just design doc: `apps/daemon/src/critique/` — `orchestrator.ts` (round/composite decision logic, OpenTelemetry tracing via `@opentelemetry/api`, Prometheus-style metrics: `critiqueCompositeScore`, `critiqueMustFixTotal`, `critiqueRoundsTotal`, `critiqueInterruptedTotal`), `parser.ts`, `scoreboard.ts` (`computeComposite`, `decideRound`, `selectFallbackRound`), `persistence.ts` (SQLite-backed run rows), `transcript.ts`, `ratchet.ts`, `conformance.ts`/`conformance-history.ts` (adapter conformance tracking over time), `rollout.ts` — ~3,400 total lines, not a stub.
- **Four-tier enable/disable resolver** (`critique-theater.md:78-98`): per-skill `od.critique.policy` (required/opt-out/opt-in) > per-project localStorage/DB override > `OD_CRITIQUE_ENABLED` env > rollout-phase default (M0/M1 off, M2 opt-in-only, M3 on-by-everywhere after ≥90% adapter conformance for 14 consecutive days). This staged-rollout gate design (dark-launch → opt-in → global, gated on a measured conformance metric, not a calendar date) is itself a notable pattern independent of the critique content.
- SSE event channel `critique.*`, i18n-abstracted product name (`critiqueTheater.userFacingName`) decoupled from internal code-path naming (`Design Jury` UI label vs `Critique Theater`/`OD_CRITIQUE_*` code).

**Verdict: 🔴 ARCHITECTURE-SHAPING.** This directly parallels our own "independent critic gate" concept (GPT-5.5 critic in autodev-loop) but implements it as **in-session multi-persona turns with a weighted rubric and auto-converging rounds**, rather than a separate critic process. Decide before freeze whether our critic gate should be (a) a same-session multi-persona pattern like this, or (b) our existing separate-process `codex exec` critic — they are not mutually exclusive (Open Design's model is arguably cheaper/faster but shares fate with the worker's own blind spots; a genuinely *independent* critic process, which is our stated design principle, is the opposite tradeoff). Worth studying `scoreboard.ts`'s round/threshold/fallback state machine regardless of which shape we pick — it's a clean, reusable "N rounds, weighted composite, fallback policy" gate primitive.

---

## Axis 6 — MODEL-ROUTING ENGINE (BYOK proxy, OpenAI-compatible, SSE, SSRF)

Two distinct layers exist; separate them clearly:

### 6a. AMR ("Agentic Model Router" / codename `vela`) — their own commercial cloud product
`apps/daemon/src/integrations/vela.ts` (1233 lines) — mostly analytics/attribution plumbing (`AmrEntryAttribution`, `TrackingAmrEntrySource` — 20+ named UI entry points for telemetry) plus a CLI adapter wrapper (`resolveAmrProfile`, spawn via `resolveAgentLaunch`/`spawnEnvForAgent`). This is Open Design's **paid, single-account, 20+-model cloud gateway** ("one recharge to use GPT, Claude, Gemini, DeepSeek" per `README.md`) — **not** a task-complexity router. `grep -rli complexity` across `apps/daemon/src` and `packages/contracts/src` returns **zero hits** — there is no model-selection-by-task-complexity logic anywhere in the codebase. This is a notable negative finding relative to our stated interest in "per-task routing": Open Design doesn't have one to copy.

### 6b. BYOK multi-provider proxy — the actually graftable piece
`apps/daemon/src/routes/chat.ts:898-2220+` registers per-provider SSE proxy routes: `/api/proxy/anthropic/stream`, `/api/proxy/openai/stream`, `/api/proxy/azure/stream`, `/api/proxy/google/stream`, `/api/proxy/ollama/stream`, plus tool-augmented variants (`/api/proxy/senseaudio/stream`, `/api/proxy/aihubmix/stream`) and a generic `/api/proxy/:provider/stream` catch-all (`chat.ts:2220`). Each handler:
1. Validates `baseUrl`/`apiKey`/`model` presence, then calls `validateExternalApiBaseUrl` (SSRF guard, see below) — 400/403 short-circuit before any network call (`chat.ts:904-921`).
2. Runs a `reasoningExecution` egress policy check (`authorizeReasoningEgress`) — an additional allow/deny gate specific to reasoning-model traffic.
3. Builds the provider-specific payload/headers (OpenAI Bearer token, Anthropic `x-api-key`/`anthropic-version`, special-cased `openrouter.ai` headers) and calls `fetch(..., { redirect: 'error' })` — **redirects are hard-rejected**, not followed, closing the classic "validate the URL, then follow a 302 into loopback" SSRF bypass.
4. Streams the upstream SSE response back to the client via `createSseResponse`/`streamUpstreamSse`, normalizing `[DONE]`/error-event shapes per provider into one internal SSE contract.

**SSRF hardening is unusually thorough** — `packages/contracts/src/api/connectionTest.ts:1-140` + `apps/daemon/src/connectionTest.ts:85-196`:
- Static hostname validation (`validateBaseUrl`, `connectionTest.ts:111-126` in contracts): rejects non-http(s) protocols; blocks `0.0.0.0/8`, `100.64.0.0/10` (CGNAT), `169.254.0.0/16` (link-local incl. cloud metadata endpoint `169.254.169.254`), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, multicast (`≥224`), IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`), IPv4-mapped IPv6 (`::ffff:x.x.x.x`) unwrapped before the same checks, and FQDN-trailing-dot normalization (`0.0.0.0.` == `0.0.0.0`) — while explicitly **allowing loopback** (`127.0.0.0/8`, `::1`, `localhost`) as a deliberate carve-out for local LLM servers like Ollama.
- **DNS-rebind protection**: `validateBaseUrlResolved` (`connectionTest.ts:113-140`) re-resolves the hostname via `dns.lookup(..., {all:true})` and re-runs the block-list against *every resolved address*, not just the literal hostname — closing the TOCTOU gap where a public hostname resolves to a private IP at request time. DNS failures are treated as non-security-relevant (fail open to let `fetch` surface the real connection error) — a deliberate, documented UX tradeoff.
- `assertAndFetchExternalAsset` (`connectionTest.ts:189-196`) composes the resolved-URL guard with a forced `redirect: 'error'` fetch specifically for **upstream-returned asset URLs** (e.g. a `data.url` in an API response) — because those are attacker-controllable if the gateway itself is compromised, a threat model layer beyond just validating the user-supplied `baseUrl`.

**Verdict: 🔴 ARCHITECTURE-SHAPING** for the BYOK/SSRF layer specifically (6b) — this is meaningfully more hardened than what most hobby projects ship (loopback carve-out + CGNAT + IPv6 ULA/link-local + IPv4-mapped-IPv6 unwrapping + DNS-rebind re-check + redirect-pinning is a fairly complete SSRF checklist) and directly reusable for our own per-task model routing once we add direct-API (non-CLI) worker backends. **⚪ REJECT** porting AMR (6a) itself — it's a vendor-specific paid-cloud integration with no generalizable routing logic, not an engine we'd want to depend on or copy.

---

## 3-Tier UI Blueprint (sidebar/nav structure)

Captured from `apps/web/src/components/EntryNavRail.tsx:1-80` + surrounding chat/panel components:

1. **Tier 1 — Global nav rail** (`EntryNavRail.tsx:17-26`, `EntryView` union): icon-only left rail, Lovart-style, docks open once activated (comment: *"Once opened the rail stays docked (Manus-style)"*, `EntryNavRail.tsx:79`). Destinations: `home | onboarding | projects | tasks | plugins | design-systems | library | brands | integrations`. Footer = help launcher; account/language controls deliberately live behind a floating settings cog instead of the rail (`EntryNavRail.tsx:8-9`) — a "primary nav stays workflow-only, account stuff stays out of the way" split worth copying verbatim.
2. **Tier 2 — Per-destination entry views**: Home (skill + design-system picker + brief composer), Automation, Design System, Plugins, Integrations — each a full-page surface reached from Tier 1, per `README.md`'s "Core pages" tour.
3. **Tier 3 — Project Studio** (inside a project): a chat-centric workspace — `ChatPane.tsx` (composer + streamed transcript + `PinnedTodoSlot` task list, per root `AGENTS.md` "Chat UI conventions") on one side, and a tabbed artifact/file viewer (`FileViewer`, srcDoc vs URL-load iframe modes per `AGENTS.md`) on the other, with auxiliary right-hand panels that mount contextually: `QuestionsPanel.tsx` (clarifying-question forms, triggered by `<question-form>` artifacts, not a tool call — see root `AGENTS.md` "Asking the user questions"), a Critique Theater live panel (per-panelist score lanes + composite ticker, Axis 5), `DesignBrowserPanel.tsx`/`DesignFilesPanel.tsx`, `ManualEditPanel.tsx`.

**Verdict: 🟡 GRAFTABLE-LATER** as a UX reference for our own web-UI blueprint — the rail/entry/studio three-layer split and the "workflow nav vs. account controls" separation are good defaults; not architecture-shaping since our UI hasn't been designed yet and this is inspiration, not a dependency.

---

## Skills (SKILL.md) / Plugins / MCP wiring

- **Skills protocol** (`docs/skills-protocol.md:1-160+`): base format is explicitly *"unchanged from Claude Code"* SKILL.md (§1), with optional `od:` frontmatter extensions (§2). **Three-location discovery with priority** (§3, `skills-protocol.md:143-149`): `./.claude/skills/` (project-private, priority 1) > `./skills/` (project-committed, priority 2) > `~/.claude/skills/` (user-global, priority 3), watched via `chokidar` in dev, re-scanned on `SIGHUP` in prod. **Symlink distribution** (§3.1, borrowed explicitly from `cc-switch`): one canonical skill dir symlinked into every active agent's expected skills location — "one install → every agent sees the skill."
- **Skill injection strategy per adapter** (`docs/agent-adapters.md:112-134`, §4): three fallback tiers — (1) native skill loading when the CLI natively scans its own skills dir (Claude Code, version-dependent Codex/OpenCode), (2) prompt injection (concatenate `SKILL.md` body + `references/*.md`, copy `assets/` into cwd) for agents with no skills concept, (3) file-placed workflow (`AGENTS.md`/`.cursorrules` written into the project cwd) for agents that read project-level instruction files. Each adapter declares its strategy via `capabilities().nativeSkillLoading`.
- **MCP wiring**: `apps/daemon/src/mcp-config.ts` (1232 lines, real per-agent MCP server config management) + `apps/daemon/src/runtimes/mcp.ts` (`buildLiveArtifactsMcpServersForAgent`) — the daemon composes/injects MCP server configs per spawned agent, and exposes its own MCP server (`mcp__open-design__*` tools visible in this very session: `list_projects`, `get_artifact`, `create_artifact`, `start_run`, `list_agents`, `list_plugins`, `list_skills`, etc.) so external agents (Claude Code, etc.) can drive Open Design itself — a genuine dogfood loop.
- **Plugins**: `apps/daemon/src/plugins/` — `installer.ts`, `lockfile.ts`, `marketplace-doctor.ts`, `bundled.ts`, `apply.ts`/`diff.ts` (declarative plugin apply with diffing), `gc.ts`, `context-craft.ts`, `connector-gate.ts`/`connector-probe.ts` — a real package-manager-like system (install/lockfile/GC/doctor), not a stub.

**Verdict: 🟡 GRAFTABLE-LATER** across the board — the skills protocol's location-priority + symlink-fanout + three-tier injection-fallback design is a strong reference for how we'd get our own "skills"/prompt-templates into multiple worker CLIs uniformly, but it's not something we need to decide before freeze (our worker backends are `claude -p` / `codex exec` today, both of which already natively support Claude-style SKILL.md / AGENTS.md, so the injection-fallback machinery is only needed once we add CLIs without native skill support).

---

## Out-of-axis surprises worth flagging

1. **Root `AGENTS.md` "Daemon data directory contract"** (see Axis 1) — a single documented invariant (`RUNTIME_DATA_DIR` resolved once, everything derives from it, subprocesses inherit rather than re-derive) that prevents an entire class of "where did this file actually get written" bugs. Worth adopting as a written rule for our own blackboard root, independent of any other steal.
2. **UI/CLI dual-track capability rule** (root `AGENTS.md`, "Capability exposure"): *every* user-facing capability must ship through both the web UI and the `od` CLI in the same PR, calling the same `/api/*` endpoints — explicitly because external agents (the CLI is literally how other agents embed Open Design) never render the web UI. Directly relevant to us: if our web UI and our own CLI/daemon API diverge, our own dogfooding (agents driving the harness) breaks silently. Consider adopting this as a PR-gate rule.
3. **Conformance-gated rollout** (Axis 5, `rollout.ts`): staged feature enablement gated on a *measured* adapter-conformance metric over a time window (≥90% for 14 consecutive days) rather than a calendar date or flag flip — a reusable pattern for how we'd roll out new critic-gate behavior without a big-bang cutover.

---

## Top 3 steals (ranked)

1. 🔴 **PATH-scan + layered-resolution agent detection** (Axis 2: `apps/daemon/src/runtimes/executables.ts`, `detection.ts`, `registry.ts`) — directly solves our worker-backend interface problem; the four-tier resolution order (env override → packaged bin → PATH+toolchain-dir scan → platform-bundle probe) and parallel/fault-isolated/streamed probing are portable almost as-is.
2. 🔴 **SSRF-hardened BYOK proxy** (Axis 6b: `packages/contracts/src/api/connectionTest.ts`, `apps/daemon/src/connectionTest.ts`, `apps/daemon/src/routes/chat.ts:898-2220`) — a near-complete SSRF checklist (private-range blocklist, IPv6 ULA/link-local, IPv4-mapped unwrapping, DNS-rebind re-check, redirect-pinning, loopback carve-out for local models) we should copy wholesale once we add direct-API worker backends.
3. 🔴 **Critique Theater's round/composite/fallback state machine** (Axis 5: `apps/daemon/src/critique/scoreboard.ts`, `orchestrator.ts`) — even if we keep our critic as a separate process (not same-session personas), the "N rounds, weighted composite ≥ threshold else fallback policy" primitive plus its four-tier enable/disable resolver (skill-policy > project override > env > rollout-phase default) is a clean, battle-tested shape for our own gate logic.

## Top 2 anti-patterns to avoid

1. **Calling env/HOME redirection "sandboxing."** `sandbox-mode.ts` is a config jail (redirected `HOME`/`XDG_*`/`TMPDIR`), not a security boundary — no seccomp/container/VM anywhere in the codebase. If we adopt worker isolation language from this repo, do not let "sandbox" come to mean "safe to run untrusted code" — it doesn't provide that here.
2. **AMR's flat "any of 20 models" router has no complexity-aware routing.** Despite the "Agentic Model Router" name suggesting task-aware routing, there is zero task-complexity logic in the codebase (`grep -rli complexity` = 0 hits). Don't assume Open Design solved "per-task model routing" — it solved "one account, many providers," which is a different (and easier) problem than the one our axis 6 is actually asking about.

**Brief file:** `D:/Projects/autodev-harness/docs/superpowers/donor-extraction/opendesign-brief.md`
