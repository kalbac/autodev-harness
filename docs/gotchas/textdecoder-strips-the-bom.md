# `[text/textdecoder-strips-bom]` — the default `TextDecoder` silently drops a UTF-8 BOM

> Found s58 (2026-07-26), while building the critic's evidence attachments (#123).
> Not found by the critic — found by asking "is the attached file byte-identical to
> the file on disk?" and then actually measuring it.

## The behaviour

`new TextDecoder("utf-8")` defaults to `ignoreBOM: false`, and that flag name reads
backwards: `false` means the decoder **consumes and removes** a leading byte-order
mark. Measured on Node 22:

```js
const withBom = Buffer.from([0xEF, 0xBB, 0xBF, 0x61]);   // BOM + "a", 4 bytes on disk

new TextDecoder("utf-8", { fatal: true }).decode(withBom)
// -> "a"      length 1, Buffer.byteLength 1     <-- the BOM is GONE

new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(withBom)
// -> "﻿a"  length 2, Buffer.byteLength 4   <-- byte-exact
```

`fatal: true` does not help: a BOM is perfectly valid UTF-8, so the strict decoder
accepts it and strips it just the same.

## Why it mattered here

The critic's evidence attachments promise the critic that each attached file is the
**complete, unmodified** current content — that promise is the whole reason a
declaration visible in an attachment may be trusted over the diff hunk. A stripped BOM
breaks it twice over:

1. The critic reviews bytes that differ from what is on disk. For a PHP file this is
   not cosmetic — a BOM before `<?php` is a real, output-corrupting defect in
   WordPress code, and it would have been invisible to the reviewer.
2. The reported size disagrees with the size the budget was computed from. The
   evidence planner budgets on the `lstat` size (4) while the prompt would print the
   decoded length (1) — the same value measured one way and used another
   (`validated-one-string-used-another.md`).

## The rule

Whenever a decode is supposed to round-trip — the text you produce will be presented
as, compared to, or budgeted as the bytes you read — pass `ignoreBOM: true`, and then
assert the round trip rather than assuming it:

```ts
const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
if (Buffer.byteLength(content, "utf8") !== expectedBytes) return refuse();
```

The assertion cannot fire for valid UTF-8, which is exactly why it belongs there: it
costs nothing and it is the only thing standing between "I assume this round-trips"
and "I checked".

Use the default (BOM-stripping) decoder only when you are consuming the text as *data*
and a leading U+FEFF would be noise — parsing a config, splitting a CSV. Never when
the bytes themselves are the subject.

## Related

- `validated-one-string-used-another.md` — the general shape: a value checked in one
  normalization and used in another.
- `boolean-whose-no-means-two-things.md` — the sibling shape (meaning, not encoding).
- `critic-sees-only-the-diff-hunk.md` — #123, the change this was found in.
- `docs/adr/007-critic-judges-the-diff-not-unverifiable-claims-about-untouched-code.md`
