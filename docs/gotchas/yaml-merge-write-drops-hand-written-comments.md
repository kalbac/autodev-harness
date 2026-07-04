# `[config/yaml-merge-drops-comments]` — a UI config-save re-emits the whole YAML file, dropping hand-written comments

## The behavior

`mergeConfigYaml` (s19, backs `PATCH /projects/:id/config`) parses the
existing `.autodev/config.yaml` into a plain object, merges the submitted
form's fields into it, and re-serializes the WHOLE object with `yaml`'s
`stringify`. This is a round-trip re-emit, not an in-place text edit — any
hand-written comments in the original file (header notes, inline
explanations like aurora's `# Dependency-free machine gate: pure PHP syntax
lint, needs no vendor/ ...`) are silently replaced by the standard
`CONFIG_HEADER` and lost. Confirmed live on s19's aurora proof: editing
`roles.worker.ladder` through the UI replaced aurora's custom 3-line header
comment with the generic scaffold header, even though only the ladder field
was touched.

## Why this is accepted, not a bug

Preserving comments through a parse→merge→stringify round trip requires a
comment-aware YAML AST (e.g. a CST-preserving library), which is real scope
beyond a first-cut config-write endpoint (YAGNI — no such requirement was
raised). Data-wise the merge is correct (every field not covered by the form
survives byte-for-byte in value); only human-authored prose commentary is
lost. `ProjectSettingsView`'s footer note should stay honest about this
(a UI save rewrites the file) so an operator with a heavily-commented
`config.yaml` chooses file-editing over the UI when comments matter to them.

## If this needs fixing later

Reach for a comment-preserving YAML library (e.g. one that keeps a CST/AST
with comment nodes, not `yaml`'s plain `parse`/`stringify`) and merge INTO
that structure rather than a plain JS object. Don't attempt a regex-based
"patch just this one line" approach — that reintroduces the exact class of
fragility the schema-validated merge was designed to avoid.

## Related
- `gotchas/hub-cache-must-evict-on-external-config-write.md`
- `gotchas/config-write-must-guard-the-file-not-just-its-parent-dir.md`
