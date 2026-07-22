# Line-scoped profile gates — design

> **Status:** approved by the operator 2026-07-22 (s51), decision by decision.
> **Closes:** the limitation the Profiles v1 live proof exposed —
> `docs/gotchas/profile-gates-must-be-diff-scoped.md`, "What is STILL not solved".
> **Principle anchor:** #15 (the gate proves only formalized properties) and #10
> (when unsure, fail toward the safe state).

## The problem, measured

Profile gates scope to changed **files**. A task touching an existing file
therefore inherits that file's entire pre-existing debt. On the real polygon:

| Measurement | Value |
|---|---|
| WPCS errors across the tree | **7069** (115 files) |
| WPCS errors in the one file a task changed | **8** |
| Polygon PHP files clean under the profile ruleset | **0 of 4** checked |
| Of the 7069, auto-fixable by PHPCBF | 4633 |

The last row is the verdict on file-level scoping: **every** task touching
existing code is red before the worker writes a line. Profiles v1 is practically
green only for new files.

File-level scoping made the gate *meaningful* (7069 → 8). Line-level scoping is
what makes it *usable*.

## The question this answers

**Is the worker responsible for the file it touched, or for the lines it wrote?**

Decision: **the lines it wrote.** Findings are kept only when they land on lines
the diff actually added. This is the same rule the rest of the machine gate already
follows (`resolveScope`, `zonesTouchedInDiff` — everything here is diff-scoped);
file-level profile gates were the outlier.

## Decisions taken

| # | Fork | Decision | Why |
|---|---|---|---|
| 1 | Responsibility model | **Line-scoped filtering** | The only option that makes the gate both meaningful and usable on legacy code *without* introducing a new oracle artifact. A **baseline file** was rejected specifically because a baseline **is an oracle**: a worker able to regenerate it could whitewash everything in one commit — the exact reward-hacking Principle 14 and `adr/006` exist to stop. "You touched it, you clean it" was rejected on the measurement above. |
| 2 | How findings are parsed | **Checkstyle XML only**, declared per gate as `report: checkstyle` | PHPCS, PHPStan, ESLint, Psalm and most linters emit it — one parser, widest reach, least guessing. A closed set of per-tool formats or per-gate regexes would each multiply the "parser written against a guessed external format" risk this repo already has a gotcha for (`agent-ci-ndjson-keyed-by-event-not-type`). Add a second format only when a real tool needs one. |
| 3 | Does the worker hear about out-of-diff debt? | **No** | We just built a feedback channel the worker is *required* to act on. Mixing non-actionable information into it dilutes that meaning immediately, and an invitation to clean up unscoped code fights the anti-drift critic. Reporting the debt as an operator-facing metric is deferred to the metrics work, where it has a consumer. |

## Architecture

Four seams. Nothing new in the decision cascade.

### 1. A gate declares its report format

```yaml
- id: phpcs
  files: "**/*.php"
  report: checkstyle
  run: "vendor/bin/phpcs -q --report=checkstyle --standard={profile}/gates/phpcs.xml {files}"
  redExitCodes: [1, 2]
```

`report` is **optional**. Without it a gate behaves exactly as today: whole-file,
verdict from the exit code. That is not a legacy path — it is correct for a gate
with no per-line findings at all (`composer validate` judges a manifest).

### 2. Added-line ranges come from the diff

A new pure function maps the unified diff to *added line numbers in the new file*,
per path. Walking hunks: `@@ -a,b +c,d @@` sets the new-file cursor; a context line
advances it; a `+` line advances it **and** records the number; a `-` line does not
advance it.

Only **added** lines count. A finding on a line the worker deleted cannot exist,
and a modified line is an added line in the new file — so "added lines" is exactly
"lines this diff is responsible for". A brand-new file is entirely added lines, so
it is fully covered, which is the behaviour Profiles v1 already had for new files.

### 3. Findings are parsed, filtered, and re-rendered

The checkstyle parser yields `{ file, line, severity, message, source }`. Then:

- **Path normalization.** Tools emit absolute paths; the diff speaks
  worktree-relative, `/`-separated paths. Every finding path is normalized to that
  form before matching — the same "state the normal form once and enforce it at the
  entry point" rule that `oracle-paths.ts` needed five review rounds to learn.
- **Filtering.** A finding is kept when its path is in the changed set **and** its
  line is in that path's added-line set.
- **The verdict comes from the filtered count, not the exit code.** The tool will
  legitimately exit non-zero while every finding sits outside the diff — that is a
  **green** gate. `redExitCodes` keeps its existing job: separating "ran and found
  things" from "could not run at all", which is what protects the infinite-RETRY
  guarantee built for gate feedback.
- **The feedback document is re-rendered by us** from the parsed findings, so the
  worker sees exactly the findings it owns, in a format we control.

### 4. Fail-closed rules (all three are Principle 10)

- A gate declaring `report: checkstyle` whose output does not parse → **unrunnable**
  (throw → escalate). Not green: a gate whose report we cannot read has proven
  nothing.
- A finding whose path **cannot be attributed** to a changed file → **kept, and
  blocking**, flagged in the document as unattributed. Dropping it would be
  fail-open (a real violation on the worker's own lines silently ignored); keeping
  it is a visible, loud failure the operator can act on.
- A finding with **no line number** (file-level) → kept only when the file is
  **entirely new**. On an existing file it is by definition pre-existing.

## What this does NOT change

- `redExitCodes` and the RED-vs-UNRUNNABLE distinction — untouched.
- Gates without `report` — byte-identical behaviour.
- The oracle/protected-path model — no new artifact is introduced, which was the
  whole reason this option was chosen over a baseline.
- The critic's remit (`adr/005`) — this is the mechanical gate only.

## How it will be proven

Unit: the diff line-number mapper (multi-hunk, new file, deletion-only, CRLF), the
checkstyle parser **pinned on a real captured PHPCS report** (never a hand-written
fixture — that is the `agent-ci-ndjson` lesson), path normalization, and the filter.

Live, on `woodev-shipping-plugin-test`, three directions:

1. A task that adds a **compliant** change to a **legacy** file with known
   pre-existing violations → gate **green**, task commits. This is the direction
   that proves the whole point; it is impossible today.
2. A task that adds a **non-compliant** line to that same legacy file → gate red,
   and the feedback document lists **only** the new violation, not the file's
   pre-existing ones.
3. A brand-new non-compliant file → every finding is in-diff, so behaviour matches
   Profiles v1 (no regression for new files).

## Related

- `docs/gotchas/profile-gates-must-be-diff-scoped.md` — the limitation this closes.
- `docs/gotchas/agent-ci-ndjson-keyed-by-event-not-type.md` — why the parser is
  pinned on real captured output.
- `docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md` — the
  path-normal-form discipline reused here.
- `docs/PRINCIPLES.md` — #10 (fail toward the safe state), #14 (the worker does not
  write its own oracle — the argument that killed the baseline option), #15.
