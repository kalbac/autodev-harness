# `[normalize/worker-eol-nondeterministic]` — the CRLF papercut is worker-EOL-dependent; force CRLF to prove activation

**Found:** s53 (EOL-normalization live proof).

## The surprise

The CRLF-vs-WPCS papercut assumes "a worker on Windows writes `\r\n` for a new file". But
whether the worker (`claude -p`, Sonnet) actually emits CRLF is **not deterministic** —
in the s53 live proof the worker wrote a brand-new `.php` file with **LF**, so the papercut
never manifested and the normalization step was a legitimate no-op (`normalized: 0 files`,
task committed green anyway). That run proved *no regression* but NOT *activation*.

Mechanism detail that matters: the polygon has `core.autocrlf=true`, but that only
converts files git itself checks out / stages — it does **not** touch a worker's UNSTAGED
new file. So phpcs (which reads the worktree file directly) sees exactly the bytes the
worker wrote. If the worker wrote LF → phpcs green, no papercut.

## The rule

To OBSERVE the normalization activating end-to-end in the harness, **make the task
explicitly instruct CRLF line endings** ("write the file using Windows CRLF `\r\n`"). Then
the worktree file is CRLF, phpcs would red on the added line-1 EOL finding, and the
normalization step fires — visible as the conductor log line `normalized CRLF->LF in N
file(s)` followed by a green gate and a DONE+commit with an LF committed file (s53:
`fb21553`). The deterministic causal chain (CRLF → phpcs exit 2; LF → phpcs exit 0) is
better proven separately with the real ruleset (`php vendor/bin/phpcs --sniffs=
Generic.Files.LineEndings`) than left to a non-deterministic natural run.

## Related

- `docs/superpowers/specs/2026-07-23-eol-normalization-design.md`
- `docs/gotchas/profile-gates-must-be-diff-scoped.md` — the line-scoping that made an
  existing file's EOL finding survivable but left a NEW file exposed.
