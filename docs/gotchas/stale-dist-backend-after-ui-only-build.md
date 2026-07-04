# `[build/stale-dist-backend]` — a UI-only build leaves the served daemon stale

**Tag:** `[build/stale-dist-backend]`
**Found:** s23 (2026-07-04), during the run rename/archive browser-smoke.

## Symptom

Added a brand-new backend route (`PATCH /projects/:id/runs/:runId`), rebuilt the UI with
`npm run build:ui`, served the daemon (`node dist/index.js serve`), and drove it from the browser.
The PATCH returned **404** — even though the route, the tests, and typecheck were all green. The UI
itself rendered fine (its bundle WAS fresh).

## Cause

`npm run build:ui` compiles ONLY the `ui/` workspace (Vite → `dist/ui`). It does **not** run `tsc`
on the daemon's `src/**`. The served `node dist/index.js` is the **backend** bundle, produced by the
ROOT `npm run build` (`tsc` → `dist/` + `scripts/copy-assets.mjs`). So after a backend source change,
a UI-only build leaves `dist/index.js` stale — the new route doesn't exist in the running process, and
every request to it 404s at the dispatcher's final fallthrough. It looks like a routing bug in code
that is actually correct; the code just isn't in the running binary.

## Rule

Before any **live browser-smoke that exercises a backend change**, rebuild **BOTH**:

```
npm run build        # root: tsc -> dist/ (the daemon) + copy-assets
npm run build:ui     # ui/  -> dist/ui (the dashboard bundle)
```

then (re)start `serve`. A UI-only iteration (`build:ui` alone) is fine ONLY when the change is
purely in `ui/`. If a smoke of a NEW endpoint 404s while its unit tests pass, suspect a stale
`dist/index.js` first — restart from a fresh root build before debugging the route.

## Related
- `[ui/serve-uidir-reporoot]` — the sibling serving-path gotcha (where the daemon looks for `dist/ui`).
- The UI live-smoke recipe (CURRENT-STATE constraints): `npm run build` + `npm run build:ui`, then
  `AUTODEV_REGISTRY=<tmp>/projects.json node dist/index.js serve --port <port>` DETACHED.
