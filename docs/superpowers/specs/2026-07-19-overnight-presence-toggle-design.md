# Overnight presence toggle — design (v2 slice of ADR-004's unattended half)

> Status: approved by the operator (s46, 2026-07-19), section-by-section.
> Follows `2026-07-17-unattended-overnight-escalation-handling-design.md` (the v1 slice,
> shipped s45). That slice built the deterministic overnight escalation supervisor; this
> one makes it **reachable** — from the daemon and from the UI.

## Context

s45 shipped `superviseOvernight` (`src/autonomy/overnight-supervisor.ts`) plus the config
flag `autonomy.overnight.{enabled,maxAutoReworks}`, wired through `runOrSupervise`
(`src/composition/root.ts:740`). A recon at the start of s46 found three gaps that together
make the shipped slice unreachable in practice:

1. **The daemon never calls it.** `runOrSupervise` has exactly one caller —
   `src/index.ts:289`, the CLI `run` verb. Both daemon-side run triggers
   (`root.ts:822` `trigger`, used by `POST /orchestrate`; and `index.ts:200`, the reply-B
   re-drain) call `conductor.run` directly, bypassing the overnight branch entirely. The
   s45 live-proves were headless CLI runs, which is why this did not surface then.
2. **The flag cannot be set from the UI.** `autonomy` is absent from the config write
   whitelist (`ScaffoldFormSchema`, `src/registry/scaffold.ts:26-72`, `.strict()` — so a
   `PATCH /projects/:id/config` carrying it returns 400 `invalid_config`) and absent from
   the read projection (`buildProjectConfigView`, `src/api/config-view.ts:21-57`).
3. **ADR-004 asks for a global toggle; the flag is per-project.** ADR-004 tenet 5:
   autonomy level is a function of *operator presence*, "a single global switch in the top
   bar (presence is a property of the operator, not of a project)". The shipped flag lives
   in each project's `.autodev/config.yaml`, and the daemon has no global settings store —
   only `~/.autodev/projects.json` (`{id,name,path}` entries) and `~/.autodev/daemon.log`.

## Goal

An operator-visible switch that genuinely changes what the daemon does overnight, with an
honest report of whether it will actually do anything.

## Decisions (operator-picked, s46)

| Fork | Decision | Rejected alternatives |
|---|---|---|
| Slice scope | Daemon wiring **+** global store **+** UI toggle, together | UI-only (a decorative switch over a flag the daemon never reads); backend-only |
| Storage semantics | **Global master AND per-project opt-in** — a new global store holds operator presence; the existing per-project `autonomy.overnight.enabled` means "this project is allowed to run unattended"; overnight runs on the intersection | Pure-global (one click makes every registered repo autonomous — no safety catch); fan-out writes into every project's YAML (N writes, partial-failure story, and each write destroys hand-written comments — `[config/yaml-merge-drops-comments]`) |
| Toggle lifetime | **Plain persistent boolean.** Survives daemon restart; cleared only by the operator | `until HH:MM` auto-expiry (ADR-004 calls it optional; drags in a daemon timer, timezones, restart semantics — no observed pain yet, backlog it); session-scoped reset on restart (a restart would silently disarm autonomy mid-night) |
| Flag delivery to a live daemon | **Read-through port** — `presence()` reads the settings file fresh on every `runOrSupervise` call | In-memory daemon singleton (the CLI verb cannot see daemon memory, so the file read is needed anyway — this only adds a second path); threading presence through every call site |
| UI placement | **Sidebar footer**, above `SidebarSettingsMenu`, next to the daemon status badge | A new full-width global top bar (literal ADR-004 wording; costs a new shell row in a transcript-forward layout plus a responsiveness rebuild, for one control) |

The placement decision knowingly diverges from ADR-004's literal "top bar" wording. The
app has no global top bar at all: `AppShell` (`ui/src/components/AppShell.tsx:49-69`) is
sidebar + `SidebarInset` with no header, and `ProjectTopBar` is a per-project strip owned
by the routed views. The sidebar footer is the app's only global chrome and already hosts
the daemon connection badge, which is the same semantic group ("state of my rig"). The
ADR's intent — one global, always-visible switch — is preserved.

## Non-goals (explicitly out of this slice)

- `until HH:MM` auto-expiry (backlog).
- Exposing `maxAutoReworks` in the UI — it stays a YAML field.
- Per-project *override* of presence (ADR-004: "per-project overrides only if a real need
  appears later"). The per-project flag here is an opt-in gate, not an override.
- The morning report, the north-star document, and the mandatory anti-drift critic — the
  remaining ADR-004 pieces, each its own brainstorm → spec → plan.
- Any change to gate/critic/commit semantics. ADR-004 tenet 6 and adr/003 R1 stand
  verbatim: this slice moves nothing across the enforcement boundary.

## Architecture

### New module — `src/settings/` (global daemon settings)

File: `~/.autodev/settings.json`, alongside `projects.json` and `daemon.log`. Overridable
via `AUTODEV_SETTINGS`, mirroring the `AUTODEV_REGISTRY` precedent (`src/index.ts:129`) —
required for hermetic tests.

Shape:

```json
{ "overnight": { "enabled": false } }
```

An object rather than a bare boolean so a later `until` field is an additive change, not a
breaking migration. The root schema is `.strict()` — per `[config/zod-strict]`, a plain
`z.object` silently strips unknown keys, so a stale or misspelled file would load clean
and revert every field to defaults with no error.

`loadSettings()`:
- missing file → defaults (`overnight.enabled: false`). This is a first run, not an error.
- unreadable / invalid JSON / schema violation → defaults **plus one ERROR log**, daemon
  keeps running. Same fail-soft shape as `loadRegistry` (`[registry/json-win-backslash]`).

`saveSettings()`:
- writes via tmp-file + rename;
- serialized through a promise-chain mutex, as `ProjectAdmin` does
  (`src/registry/admin.ts:105-115`);
- `lstat` guard — refuse when `settings.json` exists and is not a regular file
  (`[scaffold/config-file-symlink]`: a directory-level guard does not transfer to a
  single-file write shape).

### Consumption — `runOrSupervise`

```ts
const runOrSupervise = async (runOpts?: ConductorRunOptions): Promise<void> => {
  const overnight = (await readPresence()) && cfg.autonomy.overnight.enabled;
  if (overnight) await superviseOvernight(buildSupervisorDeps(runOpts));
  else await conductor.run(runOpts);
};
```

`readPresence` is injected at the composition root and reads the settings file fresh on
every call; any failure resolves to `false`. Because nothing is cached, the `hub.ts:26`
staleness caveat (an in-flight run keeps the `ProjectRoot` it captured) does not apply to
the global half — a click takes effect on the very next run trigger. The per-project half
still comes from the captured `cfg` and is refreshed by the existing `hub.evict` on config
write (`src/index.ts:245-258`), which is already correct.

### Daemon wiring

`src/composition/root.ts:822` changes from `trigger: (opts) => conductor.run(opts ?? { once: true })`
to route through `runOrSupervise`. That is the whole wiring change: `superviseOvernight` is
itself a loop-until-dry (drain → reason-route escalations → repeat), so one evening trigger
covers the night. No scheduler, no new timer.

`src/index.ts:200` (the reply-B re-drain) deliberately stays on `conductor.run`: an
operator answering an escalation is present by definition, so the unattended supervisor has
no business in that path.

**Implementation detail to verify during the build:** `buildSupervisorDeps` builds its
`drain` as `conductor.run({ ...runOpts, drain: true })` (`root.ts:714`), while `trigger`
passes `{ once: true }`. Confirm `once` and `drain` do not conflict in
`ConductorRunOptions`; when supervising, the drain must be a true drain.

### HTTP — two global routes

Style follows the existing global routes (`/projects`, `/fs/dirs`, `/agents/detect`,
`/system/git`, `src/api/server.ts:2300-2316`).

- `GET /settings` → `{ overnight: { enabled }, optedInProjects: number, totalProjects: number }`
- `PATCH /settings` ← `{ overnight: { enabled } }`, validated by a `.strict()` form schema,
  responds with **the same body shape as `GET /settings`** (settings plus both counts) — the
  "return the fresh view" contract of `PATCH /projects/:id/config` (`server.ts:1366-1417`),
  so the UI can write one response straight into the query cache without a refetch.

No `hub.evict` is needed; nothing caches the settings. That is the payoff of read-through.

`optedInProjects` is computed by reading each registered project's `.autodev/config.yaml`
**directly**, without building composition roots — `hub.list()` deliberately never forces a
build (`src/hub/hub.ts:16-18`), and forcing N roots to render a count would be a real cost.
A project whose config is missing or unreadable counts as not-opted-in; the count never
fails the request.

### Opening the per-project opt-in

- add `autonomy` (only `overnight.enabled`) to `ScaffoldFormSchema`'s whitelist;
- project it in `buildProjectConfigView`;
- mirror it in the UI types `ProjectConfigView` / `ProjectConfigForm`
  (`ui/src/lib/api.ts:109,139`).

## UI

### Sidebar footer (`ui/src/components/Sidebar.tsx:95-101`, above `SidebarSettingsMenu`)

```
Expanded (>=1280)                       Collapsed (<1280, icon mode)
+-----------------------------+         +------+
|  > threads                  |         |  [T] |
|-----------------------------|         |------|
|  Overnight          [==o]   |         | [((] |  <- moon icon, tone = state
|  on - 1 of 3 projects       |         | [M]  |     tooltip: "Overnight: on - 1 of 3 projects"
|-----------------------------|         +------+
|  (M) maksim        * live   |
+-----------------------------+
```

The sub-line is the honesty mechanism, not decoration:

| State | Sub-line | Tone |
|---|---|---|
| off | `off - attended` | muted |
| on, ≥1 project opted in | `on - 1 of 3 projects` | normal |
| on, zero projects opted in | `on - no project opted in` | warning (amber) |

The third row is a real reachable state under AND semantics: the operator flips the global
switch, no project has opted in, and nothing happens all night. Staying silent there is
exactly the failure class this slice exists to remove, and exactly what
`[ui/fire-and-forget-action-needs-feedback-at-point-of-action]` warns about — feedback must
appear on the screen where the action was taken.

**shadcn-first check (AGENTS.md).** The purpose-built primitive is `switch` (present in the
`@shadcn` registry, **not** yet vendored in `ui/src/components/ui/`). Alternatives
examined and rejected: `toggle-group` (vendored, but it models segmented choice — it backs
the theme selector) and `checkbox` (form-field semantics, not a mode switch). Vendor
`switch` via the shadcn MCP — that is the standing fix for
`[ui/shadcn-cli-vendor-windows]`. The row follows the registry's `field-switch` example
composed with the already-vendored `field`. The collapsed variant is `SidebarMenuButton` +
`Tooltip` (both vendored) with a lucide `Moon` icon. No new custom widget.

### Project settings screen

One `SettingsRow`: **Overnight autonomy** + `checkbox`, described as "Allow this project to
run unattended when overnight mode is on", with a note stating the AND semantics
explicitly.

### Data layer

`useSettings()` — a global query, key `["settings"]`, in the shape of `useSystemGit`
(`ui/src/lib/queries.ts:259`). `useUpdateSettings()` — mutation that writes the fresh
server response back with `setQueryData` and invalidates on error, following
`useUpdateProjectConfig` (`queries.ts:229-238`). Writing a project's config also
invalidates `["settings"]`, because `optedInProjects` may have changed.

## Error handling

| Failure | Behaviour |
|---|---|
| `settings.json` missing | defaults (overnight off); not an error |
| corrupt JSON / schema violation | defaults + one ERROR log; daemon keeps serving |
| `settings.json` is not a regular file | typed error, write refused |
| presence read throws inside `runOrSupervise` | `false` → plain `conductor.run` |
| `PATCH` body invalid | 400 `{error, code:"invalid_settings"}` |
| `PATCH` write fails | 500 `{error}`; UI toasts and the switch reverts |
| concurrent writes | serialized by the mutex |
| a registered project's config unreadable during the count | counted as not-opted-in |

One rule governs the table: every ambiguity resolves **toward presence** — that is, toward
*less* unattended spend. This is the same fail-direction discipline the s45 review
converged on (`[autonomy/budget-saga-order]`). The system must never fall *into* autonomy
by accident.

## Testing

- **Store:** missing file → defaults; corrupt → defaults + logged error; write/read
  roundtrip; refusal on a non-regular file; concurrent writes serialize.
- **`runOrSupervise` truth table:** all four combinations of (presence × project opt-in)
  route to supervisor vs plain run; a throwing presence read routes to the plain run.
- **Routes:** `GET` / `PATCH`; invalid body; oversized body; `optedInProjects` counting,
  including an unreadable project.
- **Whitelist / projection:** `PATCH /projects/:id/config` carrying `autonomy` now returns
  200 (a regression test against today's 400); `buildProjectConfigView` projects it.
- **UI:** the `ui/` workspace has **no test runner** (scripts are `dev`/`build`/`typecheck`/
  `preview`; there is not a single `*.test.tsx`). Standing up one is out of scope for this
  slice, so UI verification is what every prior UI session used: `typecheck` + `build` +
  the browser live-prove below, which must exercise all three sub-line states and the
  collapsed rail explicitly rather than assuming them.
- **Integration:** a real settings file + a real `ProjectRoot` — `trigger` reaches the
  supervisor and returns to the plain path after a toggle.
- **Live-prove (the real bar, operator-observable in the browser):** daemon + Chrome on
  `woodev-shipping-plugin-test`. Flip the sidebar switch → sub-line honestly reads
  `no project opted in` → set the project opt-in → sub-line reads `1 of 1` → run an intent
  with a seeded retryable escalation → supervisor entries appear in
  `.autodev/decision-journal.ndjson` (deterministic, zero-LLM, per the s45 recipe) → flip
  the switch off → the same run takes the plain path.

Gate as always: full suite + typecheck + **both** bundles built (`[build/stale-dist-backend]`)
+ an independent codex `gpt-5.6-luna` review per module, pinned.

## Boundary guarantees (ADR-004 tenet 6 / adr/003 R1)

Unchanged and re-affirmed. This slice adds a global read, one route pair, one call-site
swap, and UI. Nothing here touches the critic, the machine gate, the dirty-file fence, or
the commit path. Autonomy remains strictly **above** the gate: the toggle decides whether
escalations get reason-routed unattended, never whether something merges.

## Known edges / risks

- **A run already in flight keeps its captured `cfg`** (`hub.ts:26`), so flipping the
  *project* opt-in mid-run does not affect that run. The *global* half is read-through and
  does take effect on the next trigger. Accepted; documented in the project settings note.
- **`optedInProjects` reads YAML outside the config loader.** A deliberate, narrow
  duplication to avoid forcing root builds. It reads one field and treats every failure as
  not-opted-in, so drift cannot produce an over-optimistic count.
- **The switch remains on until cleared.** By design (decision above). If the operator
  finds himself forgetting it, `until HH:MM` is the backlogged answer.

## Related

- `docs/adr/004-live-orchestrator-presence-and-post-review-autonomy.md` — the doctrine
  (tenet 5 = this toggle; tenet 6 = the boundary).
- `docs/superpowers/specs/2026-07-17-unattended-overnight-escalation-handling-design.md` —
  the v1 slice this makes reachable.
- `docs/GOTCHAS.md` — `[config/zod-strict]`, `[scaffold/config-file-symlink]`,
  `[registry/json-win-backslash]`, `[config/yaml-merge-drops-comments]`,
  `[ui/shadcn-cli-vendor-windows]`, `[ui/fire-and-forget-action-needs-feedback-at-point-of-action]`,
  `[build/stale-dist-backend]`, `[autonomy/budget-saga-order]`.
- `AGENTS.md` — shadcn-first rule, review discipline.
