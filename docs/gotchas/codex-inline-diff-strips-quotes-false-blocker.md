# `[critic/codex]` — the codex rescue subagent's INLINE diff can strip string-literal quotes → a false "syntactically invalid" blocker

**Tag:** `[critic/codex]`
**Found:** s42 (hit TWICE in one session — both the critic-prompt review and the reply-B review)

## What happens

When a codex review is run via the `codex:codex-rescue` subagent with the diff **embedded
inline** in the prompt (the mandatory Windows workaround — `codex exec` cannot spawn a
subprocess to `git diff`, gotcha `[critic/codex]`), the inline embedding can **mangle the diff
text**: the leading `+` and the surrounding string-literal quotes of an added TypeScript line get
stripped in transit. codex then sees bare fragments like:

- `you. Judge whether THIS diff is CORRECT. If a behavioral touch is uncovered,,` (from a real
  line `+    "you. Judge whether THIS diff is CORRECT. If a behavioral touch is uncovered,",`)
- `if (choice === B && moved)` (from a real line `if (choice === "B" && moved) {`)

and reports a **`blocker`: "the production file is syntactically invalid / will not compile"** —
a **false positive**. The doubled comma is the tell: it is the string's own trailing `,` (inside
the quotes) plus the array-element `,` after the closing quote, with the quotes gone.

## Why it is always a false positive (when these hold)

The file is fine; the *diff rendering* is lossy. Confirm — do NOT patch on the claim — with the
ground truth that is already available:

- `npm run typecheck` is green (a syntactically invalid file fails `tsc`).
- `npm run build` succeeds.
- The unit tests that import and EXECUTE the changed function pass.
- (For a prompt change) the built code ran end-to-end.

If all of those hold, the "invalid syntax" blocker is an artifact of the inline embedding.
**Decline it with that rationale** and Read the actual file lines to be rigorous (a blocker
deserves a direct look), then move on. This is the standing rule "verify a critic's claim
against the actual code before patching" (`[hub/evict-on-config-write]`) applied to a whole class
of codex finding.

## What to still take seriously

Only the "invalid syntax" shape is the artifact. codex's SUBSTANTIVE findings in the same
review (real contract risks, unguarded throws, loophole analysis) are unaffected by the quote-
stripping and must be evaluated normally — s42's reply-B review also returned a genuine
`major` (an unguarded fire-and-forget hook could break the response path) that was real and
applied.

## Mitigation for next time

Prefer feeding codex the diff via a **file path it reads itself** where the sandbox allows, or
verify the embedded diff round-trips (quotes intact) before trusting a syntax-level blocker. When
in doubt, the local `typecheck`/`build`/tests are the authority over a codex syntax claim.

## Related

- `[critic/codex]` — the inline-diff Windows workaround this is a hazard of.
- `[hub/evict-on-config-write]` — "verify a critic's claim against the actual code before patching".
