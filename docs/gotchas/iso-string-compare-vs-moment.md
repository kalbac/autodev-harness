# `[time/iso-string-compare-vs-moment]` — comparing ISO timestamps as STRINGS is wrong for timezone offsets

**Found:** s53 (Morning Report, codex `gpt-5.6-luna` R1).

## The trap

A lexicographic string compare of two ISO-8601 timestamps is chronological **only when
both are the same offset** (e.g. both UTC `Z`). The moment two strings carry different
timezone offsets, the string order diverges from the time order:

```
"2026-07-23T00:30:00+03:00"  == 2026-07-22T21:30:00Z   (EARLIER)
"2026-07-23T00:00:00Z"       == 2026-07-23T00:00:00Z    (LATER)
```

Lexicographically `"2026-07-23T00:00:00Z" < "2026-07-23T00:30:00+03:00"` (because `0` <
`3` at the minute position), so a string compare calls the `Z` entry "earlier" — the
exact reverse of the truth.

## Where it bit

`buildMorningReport` compared journal timestamps with `e.ts >= since` (the `--since`
filter) and `a.ts < b.ts` (picking the "last decision"). The decision-journal's own `ts`
is always written UTC-`Z` (`new Date().toISOString()`), so the *internal* ordering was
fine in practice — but **`--since` is operator input** and may carry an offset, where the
filter would silently include/exclude the wrong entries.

## The rule

Compare timestamps as **moments** — `Date.parse(a) - Date.parse(b)` (epoch ms) — never as
strings, wherever ANY side can be arbitrary input rather than a same-offset producer.
Handle the un-parseable case explicitly (a `NaN` from `Date.parse`): keep the entry (fail
toward showing it) rather than dropping it, and **validate operator-supplied timestamps at
the boundary** (the CLI throws, the endpoint 400s) so a garbage `--since` is a loud error,
not a silently-ignored filter. Rule of thumb: if you wrote `<`/`>=`/`<=` on a value that
is or came from an ISO string, you almost certainly wanted `Date.parse` on both sides.

## Related

- `docs/superpowers/specs/2026-07-23-morning-report-design.md`
- `docs/gotchas/never-throws-catch-block-logging.md` — the other defect from the same
  review round.
