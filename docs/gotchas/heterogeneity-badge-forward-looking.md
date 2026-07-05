# `[ui/heterogeneity-badge-forward-looking]` — the same-family warning can't fire on a currently-valid config

**Tag:** `[ui/heterogeneity-badge-forward-looking]`
**Found:** s27 (2026-07-06), building the role-matrix editor.

## The trap

The s27 role-matrix editor surfaces a **heterogeneity warn badge** on the Critic card
(and a verbatim warning strip) driven by the new `ProjectConfigView.heterogeneityWarnings`
projection field, which reuses the existing `heterogeneityWarnings(cfg)` — it returns a
warning **only when `policy.heterogeneity === "warn"` AND `adapterMeta(worker.adapter).family
=== adapterMeta(critic.adapter).family`** (worker & critic share an adapter family).

The trap: **that condition is structurally impossible on any config the daemon will actually
serve today.** `assertKnownAdapters(cfg)` (`src/config/roles.ts`, called in
`buildProjectRoot` at `src/composition/root.ts:107`) throws unless
`worker.adapter ∈ {claude}` and `critic.adapter ∈ {codex}` — the two MVP adapters. Their
families are always `claude` vs `codex` → different → `heterogeneityWarnings` always `[]`.
A config with `critic.adapter: claude` (which would trigger same-family) never loads —
`buildProjectRoot` rejects it, so `GET /config` 500s/404s rather than projecting a warning.

So during the s27 live-smoke the badge **could not be demonstrated on a real serve.** Its
render is a trivial conditional; its *data* path is proven only by the codex-gated unit tests
(`src/api/config-view.test.ts`: same-family→warning, `policy=off`→[], different→[]).

## Why we shipped it anyway (it is correct, not dead)

The badge is **forward-looking, deliberately**: `heterogeneityWarnings(cfg)` already exists and
is logged at wire-time (`root.ts:108`) — surfacing it in the UI is honest and cheap. The moment
the adapter allowlist widens so a **same-family worker+critic pair becomes valid** (e.g. a
`claude` critic, or a second `codex`-family worker), the warning lights up automatically with no
UI change. It is insurance for the anti-drift invariant VISION §"independent critic is
load-bearing", not code for today's config.

## Rule

- Don't try to live-prove the heterogeneity badge with the current adapter set — you can't; a
  same-family config won't pass `assertKnownAdapters`. Prove the data path with the backend unit
  tests and the render by inspection.
- If you ever relax `WORKER_ADAPTERS`/`CRITIC_ADAPTERS` in `src/config/roles.ts` to allow a
  same-family pair, the badge becomes live — add a live-smoke of it then.
- Any UI element gated on `heterogeneityWarnings` inherits this: empty today by construction, not
  by accident.

## Related

- `[[type-strip-not-runtime-strip]]` — another "backend shape vs what actually reaches disk/UI" asymmetry.
- `src/config/roles.ts` (`heterogeneityWarnings`, `assertKnownAdapters`, `adapterMeta`).
- `src/api/config-view.ts` (`buildProjectConfigView`) + `src/api/config-view.test.ts`.
