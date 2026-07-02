# Autodev Harness — Dashboard UI

Localhost web dashboard (P2 / adr-003 R4) over the daemon's read/write API seam
(`src/api/server.ts`). Its own workspace so the heavy Vite/React/Tailwind
toolchain never entangles the headless daemon's `tsc` build.

## Stack

React 19 · Vite · TanStack Router (code-based) · TanStack Query · zustand ·
Tailwind 4 · hand-rolled shadcn-idiom primitives (`cn`/`cva`, no headless dep) ·
`@fontsource` (IBM Plex Sans/Mono + Space Grotesk, offline).

## Build & serve (production)

```sh
# from the repo root
npm run build:ui        # npm ci + vite build -> ../dist/ui
npm run build           # build the daemon
node dist/index.js serve
```

`serve` binds `127.0.0.1:4319` and serves `dist/ui` as the SPA fallback when it
exists (otherwise API-only). One daemon, one port.

## Dev

```sh
node dist/index.js serve            # daemon on :4319 (API + WS)
npm run dev:ui                      # vite dev server (:5173), proxies the API
```

Vite proxies `/state`, `/runs`, `/tasks`, `/escalations`, `/orchestrate` to the
daemon. The root WebSocket is **not** proxied — in dev the client dials
`ws://127.0.0.1:4319` directly (see `src/lib/ws.ts`); in prod it is same-origin.

## Shape

- `src/lib/` — api client, React-Query hooks, WS→invalidate, tone vocabulary.
- `src/components/` — shell + primitives (`ui/`) + task/run/escalation pieces.
- `src/views/` — Home, Board, Run transcript, Task detail (2-pane).

The dashboard holds no authoritative state: it renders server state and
re-fetches on any WS `{type:"change"}`. Launching a run only enqueues+triggers
through the same validated path the CLI uses (R1-safe; the gate stays
un-bypassable server-side).
