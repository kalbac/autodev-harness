# `[registry/json-win-backslash]` — a hand-written `projects.json` with Windows `\` paths is invalid JSON → silent empty registry

**Tag:** `[registry/json-win-backslash]`
**Seen:** s18 (2026-07-04), seeding a live-smoke registry for the settings screens.

## What happened

To browser-test the settings screens I hand-wrote a temp registry:

```json
{ "projects": [ { "id": "aurora", "name": "aurora", "path": "D:\projects\aurora" } ] }
```

`serve` came up but `GET /projects` returned `{"projects":[]}`. The daemon was
fine — the **file was invalid JSON**. `\p`, `\a`, `\U`, … are not legal JSON
string escapes (JSON allows only `\\ \" \/ \b \f \n \r \t \uXXXX`). `JSON.parse`
threw, and `loadRegistry` is deliberately **fail-soft**: a corrupt file becomes
an empty registry (+ one ERROR log) so `serve` never crashes over a bad file
(see `src/registry/registry.ts`). So the symptom is a silent, empty project
list, not an error surfaced to the UI.

Compounding it: writing the same content through a `<<'EOF'` heredoc that a shell
had already collapsed the `\\` in produced single backslashes on disk too — the
`cat` output *looked* right at a glance.

## The rule

- **Never put raw Windows `\` paths in JSON.** Use **forward slashes** —
  `"D:/projects/aurora"`. Node + Windows accept `/` everywhere, `resolve()`
  normalizes it, and it sidesteps escaping entirely. (`\\` also works but is
  easy to get wrong through a shell.)
- When a registry-backed screen shows **zero projects but the daemon is up**,
  suspect a corrupt registry file first — check the daemon stderr for the
  `registry: corrupt … — starting with an empty registry` ERROR line before
  debugging the API or the UI.
- Prefer the `Write` tool (or `POST /projects`) over a shell heredoc for JSON on
  Windows — heredoc + backslashes is a double trap.

## Related

- `[config/zod-strict]` — the *other* silent-registry-ish failure (unknown keys
  stripped → defaults). Both fail quiet; this one at the JSON layer, that one at
  the schema layer.
- `src/registry/registry.ts` `loadRegistry` (fail-soft by design).
