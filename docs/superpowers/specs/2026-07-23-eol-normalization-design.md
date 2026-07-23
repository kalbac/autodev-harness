# EOL Normalization Before the Gate — Design

> Spec authored 2026-07-23 (s53). Closes the **CRLF-vs-WPCS-on-Windows** papercut
> (`docs/CURRENT-STATE.md` NEXT ACTIONS). Anchors: `PRINCIPLES.md` #10 (fail toward
> the safe state), #13 (evidence), #15 (the gate proves only formalized properties).

## The problem

A worker running on Windows creates a new `.php` file with **CRLF** line endings
(the OS/editor artifact — the worker did not *choose* CRLF). The
`wordpress-woocommerce` profile's `phpcs.xml` pulls `WordPress-Core`, which includes
the `Generic.Files.LineEndings` sniff demanding `\n`. So a brand-new PHP file draws a
line-ending error **at line 1**.

Line-scoping (`src/gate/finding-filter.ts`, s51) filters an *existing* file's line-1
EOL finding out as pre-existing debt — but for a **new** file, line 1 *is* a
worker-added line, so the finding survives, `profile_green` goes `false`, and the task
goes to RETRY. The worker cannot fix it: re-writing the file on Windows re-introduces
CRLF, so the retry reproduces the same finding, burns the attempt budget, and the task
escalates. **A legitimate change is blocked by an environmental artifact.**

## The decision (operator, s53)

Normalize, do not blind. Excluding the sniff in the ruleset (the one-line alternative)
would (a) make the profile stop proving line endings — a real, if small, reduction in
the qualification claim — and (b) still let the **product** commit with CRLF, which is
worse for a WordPress plugin than the papercut it cures. Normalizing removes the
environmental artifact at its root: the committed artifact is LF (what WordPress wants),
the oracle stays intact and still catches genuine EOL problems on non-Windows, and no
new config surface is introduced.

The EOL target is governed by the **target repo's own `.gitattributes`** — the existing,
declarative, per-repo source of truth for line endings — with **LF as the default** when
the repo is silent. This is exactly what git itself would apply on commit; the harness is
only making the worktree match that policy *before* the gate reads it, rather than after.

## Scope

- **In scope:** normalizing the worker's actually-changed files toward **LF** in the
  worktree, after the dirty-file fence and before the diff/critic/gate, so the diff,
  the critic, the gate, and the commit all see the same LF content.
- **Non-goals (YAGNI):**
  - Normalizing *toward* CRLF. The module only ever moves CRLF → LF. A repo that
    genuinely wants CRLF declares `eol=crlf` and is left untouched; producing CRLF is
    not a thing any consumer here needs.
  - Normalizing the whole tree. Only the files the worker changed this task are touched.
  - A new config field. `.gitattributes` already exists for this; adding a knob would
    duplicate it.
  - Touching the profile ruleset. The sniff stays — it is still correct and useful on a
    non-Windows worker.

## Architecture

### New module: `src/normalize/eol.ts`

One unit, one purpose: given the set of files a worker changed, rewrite each toward LF
**unless** the repo's attributes say otherwise. It owns the "should this file be
LF-normalized, and is it already?" decision and nothing else.

```
normalizeWorktreeEol(deps, worktreePath, relPaths) -> Promise<NormalizeResult>
```

- **`deps`** (injected, so the unit is testable without a real repo/OS):
  - `checkAttr(worktreePath, relPaths) -> Promise<Map<relPath, {text, eol}>>` — thin
    wrapper over `git check-attr text eol` (batched, one git call for the whole set).
    `text` ∈ `{"set","unset","unspecified"}`, `eol` ∈ `{"lf","crlf","unspecified"}`
    (git's own vocabulary; `unset` = the `-text` "binary" declaration).
  - `readFile(absPath) -> Promise<Buffer>` / `writeFile(absPath, Buffer) -> Promise<void>`
    — bytes, not strings, so a NUL-byte check and a byte-exact "did anything change"
    comparison are possible.
  - `log(level, msg)` — for the honesty line.
- **Per-file decision** (fail toward *not* mangling, Principle 10):

  | `.gitattributes` resolution | action |
  |---|---|
  | `text` = `unset` (declared binary, `-text`) | **skip** |
  | `eol` = `crlf` | **skip** (repo explicitly wants CRLF) |
  | `eol` = `lf`, or `text` = `set` | normalize → LF |
  | unspecified (no attribute) | **default LF**, guarded: if the bytes contain a NUL, treat as binary and **skip** |

- **Normalization itself:** replace every `\r\n` with `\n`. A lone `\r` (old-Mac) is
  left alone — WPCS's concern and the worker's artifact are both specifically CRLF, and
  touching bare `\r` would widen the blast radius past the observed problem. If the file
  has no `\r\n`, it is **not rewritten** (no needless write, no spurious mtime churn).
- **Return value:** `{ normalized: relPath[]; skippedBinary: relPath[] }` — enough for a
  single conductor log line naming what was rewritten (honesty: the harness changed the
  worker's output bytes). No evidence-ledger field in v1; a log line is proportional.

### Wiring: `src/conductor/conductor.ts`

Insert one call between the dirty-file fence and the `// DIFF + CRITIC` block
(currently ~line 641):

```ts
// EOL NORMALIZATION — the worker's Windows editor may have written CRLF, an
// environmental artifact the WPCS line-ending sniff would (correctly, on that
// platform) reject on a brand-new file. Normalize the worker's changed files
// toward LF per the target repo's .gitattributes (default LF) BEFORE the diff,
// so the critic, the gate, and the commit all see the same LF content. Scoped
// to `touched` — the files that actually changed; strays already escalated above.
const eolResult = await normalizeWorktreeEol(eolDeps, wt.path, touched);
if (eolResult.normalized.length > 0) {
  safeLog("INFO", `conductor: normalized CRLF->LF in ${eolResult.normalized.length} file(s): ${eolResult.normalized.join(", ")}`);
}
```

- **Why here:** the diff at line 643 feeds the critic (648), `zonesTouchedInDiff` (671),
  and is persisted as `diff.patch`; the gate (727) computes its own diff internally; the
  commit happens after the gate. Normalizing before line 643 makes every one of those
  see LF. Placing it inside `runGate` instead would leave the line-643 diff (and the
  critic) on CRLF — inconsistent — and would make the "judge" mutate the worktree as a
  side effect.
- **Why after the fences:** we normalize only on the happy path where the worker's
  changes are already confirmed in-scope. An oracle-path or stray touch has already
  escalated and returned; we never rewrite bytes of a change we are about to reject.
- **`touched`** is the `workerTouched(baseline, now)` set — worktree-relative paths of
  what actually changed. Each is joined to `wt.path` for the fs read/write; the relative
  form is what `git check-attr` wants.
- **Composition root** (`src/composition/root.ts`) builds `eolDeps` (real
  `git check-attr`, `fs`) and passes it into the conductor, matching how the other
  conductor deps are wired.

## Interactions (verified against the current code)

- **Fences (`oracleAfter`/`dirty-file`, lines 601–639):** run *before* normalization on
  the CRLF content; they decide *which files* changed (membership), which
  CRLF→LF does not alter. `touched` is already computed (line 587) and unaffected.
- **`diff-lines.ts`:** already strips a trailing `\r` from every diff line, so
  line-scoping was never *broken* by CRLF — the issue is purely the sniff's finding on a
  new file. Normalization is belt-and-suspenders here, and correct regardless.
- **Diff size:** if the worker's editor rewrote an existing LF file wholesale as CRLF,
  git would show every line changed; normalizing back to LF **shrinks** the diff to the
  real edits — a strict improvement, not a risk.
- **Merge/commit:** normalization persists in the worktree, so the eventual
  `mergeAfterGate` commit carries LF. This is the same content git would have produced on
  `git add` under the repo's `.gitattributes` anyway.

## Error handling (Principle 10 — fail toward safe)

- A `git check-attr` failure for the batch → **do not normalize anything** this task
  (log a WARN, return an empty result). Normalization is a best-effort hygiene step; its
  failure must never block or corrupt a task. The pre-existing behavior (the sniff may
  red a new file) is the safe fallback — it parks the task, it does not merge bad output.
- A per-file `readFile`/`writeFile` failure → skip that file, WARN, continue the others.
  A partial normalization is safe: any file left CRLF simply behaves as it does today.
- The unit **never throws** to the conductor. It is wired like the other best-effort
  conductor steps.

## Testing

Unit (`src/normalize/eol.test.ts`), injecting `checkAttr`/`readFile`/`writeFile`:

1. CRLF file, attributes unspecified → rewritten to LF (bytes asserted).
2. `eol=crlf` declared → **untouched** (no `writeFile` call).
3. `text=unset` (binary declared) → **untouched**.
4. Unspecified attribute + NUL byte in content → **untouched** (binary heuristic).
5. Already-LF file → **no `writeFile`** (idempotent, no needless write).
6. Mixed batch (one normalizable + one binary + one CRLF-declared) → only the first
   rewritten; result lists it under `normalized`, the binary under `skippedBinary`.
7. `checkAttr` rejects → empty result, no writes, WARN logged (fail-safe).
8. `eol=lf` explicitly → rewritten even if a NUL is present? No — an explicit text/eol
   declaration is the operator's word and overrides the NUL guard (the guard only backs
   up the *unspecified* default). Assert an `eol=lf`-declared file is normalized.

Conductor test: a stubbed `normalizeWorktreeEol` is invoked with the `touched` set on the
happy path, and is **not** invoked when a fence escalates first (ordering pinned).

Live proof (the point of the whole change): on `woodev-shipping-plugin-test`, a task that
**adds a new `.php` file** now passes the phpcs gate green and **commits**, where before
it escalated on the line-1 EOL finding. This is operator-observable in the harness UI
(task reaches DONE with a commit), per the "prove the product goal" discipline.

## Files

- **New:** `src/normalize/eol.ts`, `src/normalize/eol.test.ts`.
- **Edited:** `src/conductor/conductor.ts` (one call + dep), `src/composition/root.ts`
  (build + inject `eolDeps`).
- **Unchanged:** the profile ruleset, `finding-filter.ts`, `diff-lines.ts`.

## Related

- `docs/PRINCIPLES.md` — #10 (fail safe), #13 (evidence), #15 (formalized properties).
- `docs/gotchas/profile-gates-must-be-diff-scoped.md` — the line-scoping that made this
  survivable for existing files.
- `docs/CURRENT-STATE.md` — NEXT ACTIONS (the papercut this closes).
