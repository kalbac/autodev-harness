# Line-scoped profile gates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A profile gate blames the worker for the lines it wrote, not for the file it touched.

**Spec:** `docs/superpowers/specs/2026-07-22-line-scoped-profile-gates-design.md`

**Architecture:** A gate may declare `report: checkstyle`. When it does, the harness parses the tool's Checkstyle XML, keeps only findings landing on lines the diff **added**, and decides the verdict from that filtered count instead of the exit code. Gates without `report` keep today's behaviour byte-for-byte.

**Tech Stack:** TypeScript, ESM, Node ≥ 20, vitest. No new runtime dependency — the parser is hand-written against a *real captured* report (see below).

---

## The real captured report — the pinned fixture

This was captured from the polygon's PHPCS **before any code was written**, and it is the shape every parser test must be built on. Do NOT hand-author a "cleaner" fixture; three properties here would not have been guessed:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="3.13.5">
<file name="C:\Users\maksi\AppData\Local\Temp\tmp.25tXBjQr2u\bad.php">
 <error line="1" column="1" severity="error" message="Class file names should be based on the class name with &quot;class-&quot; prepended. Expected class-bad-thing.php, but found bad.php." source="WordPress.Files.FileName.InvalidClassFileName"/>
 <error line="1" column="1" severity="error" message="Missing file doc comment" source="Squiz.Commenting.FileComment.Missing"/>
 <error line="2" column="1" severity="error" message="Missing doc comment for class Bad_Thing" source="Squiz.Commenting.ClassComment.Missing"/>
 <error line="3" column="1" severity="warning" message="Found precision alignment of 2 spaces." source="Universal.WhiteSpace.PrecisionAlignment.Found"/>
 <error line="3" column="17" severity="error" message="Missing doc comment for function x()" source="Squiz.Commenting.FunctionComment.Missing"/>
</file>
</checkstyle>
```

1. `<file name>` is an **absolute** path with **backslashes** — it must be normalized to a worktree-relative `/`-separated path before it can be matched against the diff.
2. Messages carry **XML entities** (`&quot;`) — they must be unescaped or the worker reads mangled text.
3. `severity` is `error` **or `warning`** — both block, matching today's behaviour where PHPCS exit 1 and 2 are equally RED. Introducing a severity policy here would be a second, unasked-for change.

---

### Task 1: Added-line numbers from a unified diff

**Files:** create `src/gate/diff-lines.ts`, `src/gate/diff-lines.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { addedLineNumbers } from "./diff-lines.js";

const DIFF = `diff --git a/includes/a.php b/includes/a.php
index 111..222 100644
--- a/includes/a.php
+++ b/includes/a.php
@@ -10,6 +10,7 @@ class A {
 	public function keep() {
 		return 1;
 	}
+	public function added() {}
 	public function tail() {
 	}
 }
`;

describe("addedLineNumbers", () => {
  it("records only ADDED lines, numbered in the NEW file", () => {
    const m = addedLineNumbers(DIFF);
    expect([...m.get("includes/a.php")!]).toEqual([13]);
  });

  it("handles several hunks in one file", () => {
    const d = `--- a/x.php
+++ b/x.php
@@ -1,2 +1,3 @@
 a
+b
 c
@@ -20,2 +21,3 @@
 d
+e
 f
`;
    expect([...addedLineNumbers(d).get("x.php")!]).toEqual([2, 22]);
  });

  it("treats a brand-new file as entirely added", () => {
    const d = `--- /dev/null
+++ b/new.php
@@ -0,0 +1,3 @@
+one
+two
+three
`;
    expect([...addedLineNumbers(d).get("new.php")!]).toEqual([1, 2, 3]);
  });

  it("a deletion-only hunk adds nothing and does not shift the cursor", () => {
    const d = `--- a/x.php
+++ b/x.php
@@ -1,3 +1,2 @@
 a
-b
 c
`;
    expect(addedLineNumbers(d).get("x.php") ?? new Set()).toEqual(new Set());
  });

  it("covers several files in one diff", () => {
    const d = `--- a/x.php
+++ b/x.php
@@ -1,1 +1,2 @@
 a
+b
--- a/y.php
+++ b/y.php
@@ -5,1 +5,2 @@
 c
+d
`;
    const m = addedLineNumbers(d);
    expect([...m.get("x.php")!]).toEqual([2]);
    expect([...m.get("y.php")!]).toEqual([6]);
  });

  it("survives CRLF line endings", () => {
    const d = "--- a/x.php\r\n+++ b/x.php\r\n@@ -1,1 +1,2 @@\r\n a\r\n+b\r\n";
    expect([...addedLineNumbers(d).get("x.php")!]).toEqual([2]);
  });

  it("ignores the +++ header, which also starts with a plus", () => {
    // The classic off-by-one in every hand-rolled diff parser.
    const m = addedLineNumbers(DIFF);
    expect(m.has("b/includes/a.php")).toBe(false);
    expect([...m.get("includes/a.php")!]).not.toContain(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/gate/diff-lines.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement.** Walk the diff line by line. `+++ b/<path>` sets the current path (strip the `b/` prefix; `/dev/null` means a deletion, skip the file). `@@ -a,b +c,d @@` sets the new-file cursor to `c`. Then: a line starting with `+` (and not `+++`) records the cursor and advances it; a line starting with `-` (and not `---`) advances nothing; a line starting with a space, or an empty line, advances the cursor. `\ No newline at end of file` is ignored. Strip a trailing `\r` from every line first, so CRLF diffs behave identically.

Comment the two traps explicitly: the `+++`/`---` headers also start with `+`/`-`, and the cursor advances on context lines but not on removals.

- [ ] **Step 4: Green** — `npx vitest run src/gate/diff-lines.test.ts`

- [ ] **Step 5: Commit** — `feat(gate): map a unified diff to its added line numbers`

---

### Task 2: The Checkstyle parser

**Files:** create `src/gate/checkstyle.ts`, `src/gate/checkstyle.test.ts`, and the fixture `src/gate/__fixtures__/phpcs-checkstyle.xml` containing the REAL report quoted at the top of this plan, verbatim.

- [ ] **Step 1: Write the failing tests**, reading the fixture from disk (never an inline hand-written string — that is the `agent-ci-ndjson-keyed-by-event-not-type` lesson: a self-authored fixture is vacuously green and proves nothing about the real tool):

```ts
const xml = readFileSync(new URL("./__fixtures__/phpcs-checkstyle.xml", import.meta.url), "utf8");

describe("parseCheckstyle (pinned on a REAL PHPCS report)", () => {
  it("extracts every finding with its file, line, severity, message and source", () => {
    const found = parseCheckstyle(xml);
    expect(found).toHaveLength(5);
    expect(found[0]).toMatchObject({
      file: "C:\\Users\\maksi\\AppData\\Local\\Temp\\tmp.25tXBjQr2u\\bad.php",
      line: 1,
      severity: "error",
      source: "WordPress.Files.FileName.InvalidClassFileName",
    });
  });

  it("unescapes XML entities in the message", () => {
    const found = parseCheckstyle(xml);
    expect(found[0]!.message).toContain('"class-"');
    expect(found[0]!.message).not.toContain("&quot;");
  });

  it("keeps warnings, not only errors", () => {
    expect(parseCheckstyle(xml).some((f) => f.severity === "warning")).toBe(true);
  });

  it("returns [] for a report with no findings", () => {
    expect(parseCheckstyle('<?xml version="1.0"?>\n<checkstyle version="3.13.5"/>')).toEqual([]);
  });

  it("THROWS on unparseable output rather than reporting zero findings", () => {
    // Zero findings means "clean" -- so a parse failure that returned [] would
    // turn a broken gate into a PASS. It must be unrunnable instead.
    expect(() => parseCheckstyle("phpcs: command not found")).toThrow(/checkstyle/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** with a regex scan over `<file name="...">` blocks and their `<error .../>` children — no XML dependency for this shape, but the module doc must say plainly that it handles the Checkstyle subset these tools emit, not arbitrary XML, so nobody later mistakes it for a general parser. Unescape the five XML entities (`&amp; &lt; &gt; &quot; &apos;`), **`&amp;` last** or you double-unescape. A document with no `<checkstyle` root throws.

- [ ] **Step 4: Green.** - [ ] **Step 5: Commit** — `feat(gate): checkstyle parser pinned on a real PHPCS report`

---

### Task 3: Path normalization + the filter

**Files:** create `src/gate/finding-filter.ts`, `src/gate/finding-filter.test.ts`

- [ ] **Step 1: Write the failing tests** covering, at minimum:
  - an absolute Windows path under the worktree normalizes and matches its diff entry;
  - a POSIX absolute path likewise;
  - a finding on an added line is KEPT; on an unchanged line is DROPPED;
  - a finding in a file the diff never touched is DROPPED;
  - a finding whose path cannot be attributed to any changed file is **KEPT and flagged** `unattributed: true` (fail-closed: dropping it would silently ignore a real violation on the worker's own lines);
  - a finding with **no line number** is kept only when the file is entirely new (every line added), dropped otherwise.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** `filterFindings(findings, addedLines, worktreePath)`. Normalize each finding path to a worktree-relative `/`-separated form; `path.relative` emits the host separator, so fold it. State the normal form ONCE at the top of the module and enforce it at the entry point — `oracle-paths.ts` needed five review rounds to learn that lesson; do not re-learn it here.

- [ ] **Step 4: Green.** - [ ] **Step 5: Commit** — `feat(gate): filter findings to the diff's added lines`

---

### Task 4: Wire it into the gate

**Files:** modify `src/profile/schema.ts` (`report?: "checkstyle"`), `src/profile/profile.ts` (carry it onto `ResolvedGate`; a gate declaring `report` must produce output — cross-check as with `files`/`{files}`), `src/gate/gate.ts`, `src/composition/root.ts`, plus their tests.

- [ ] **Step 1: Tests first**, in `src/gate/gate.test.ts`:
  - a gate with `report` whose findings are ALL outside the diff → `profile_green: true`, decision COMMIT, **even though the tool exited non-zero**. This is the whole feature; assert the exit code really was non-zero in the fixture.
  - a gate with `report` and one in-diff finding → RETRY, and the feedback document contains that finding's message and NOT the out-of-diff ones.
  - a gate with `report` whose output does not parse → **throws** (unrunnable), not green.
  - a gate WITHOUT `report` → byte-identical to today (exit-code verdict).
  - an exit code outside `redExitCodes` still classifies unrunnable BEFORE any parsing is attempted.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** `runProfileGates` results gain optional structured findings. The order in `runGate` matters and must be commented: **classify the exit code first** (`classifyGateExit`), and only parse when the outcome is "red". An unrunnable exit must never reach the parser — otherwise a tool that failed to start could produce an empty report and read as clean.

- [ ] **Step 4:** `npm run typecheck && npx vitest run` — whole suite green.

- [ ] **Step 5: Commit** — `feat(gate): line-scoped verdict for gates declaring a report format`

---

### Task 5: Re-render the feedback from findings

**Files:** modify `src/gate/gate-feedback.ts` + tests.

A `FailedStep` may now carry structured findings instead of raw output. When it does, render them as a readable list (`path:line  message  [source]`) rather than dumping the XML — the worker must never be shown the machine format. Unattributed findings are rendered in their own clearly-labelled group, so the operator can see the fail-closed case fired.

Keep every existing bound: per-step clamp, label clamp, global cap, fence selection.

- [ ] Tests, implement, `npx vitest run`, commit — `feat(gate): render structured findings in the feedback document`

---

### Task 6: The profile adopts it

**Files:** `profiles/wordpress-woocommerce/profile.yaml`

Switch the `phpcs` gate to `--report=checkstyle` plus `report: checkstyle`. Bump the profile to **version 2** — the gate's observable behaviour changes, and a pinned version that silently changes meaning defeats the point of pinning. Update `profiles/README.md` for the new key, and the polygon's `.autodev/config.yaml` to `wordpress-woocommerce@2`.

- [ ] Verify the profile loads from `dist/`, commit — `feat(profile): wordpress-woocommerce@2 -- line-scoped phpcs`

---

### Task 7: Live proof — three directions

Polygon `woodev-shipping-plugin-test`; disable `gate.agentCi` for the run and restore after. FOREGROUND runs only.

- [ ] **Direction 1 — the one that proves the feature.** A task adding a *compliant* method to an EXISTING legacy file with known pre-existing violations → gate **green**, task **commits**. Impossible before this change; capture the commit SHA and the verdict.
- [ ] **Direction 2 — the filter is real.** A task adding a *non-compliant* line to that same legacy file → RETRY, and `gate-feedback.md` lists **only** the new violation. Assert a known pre-existing violation of that file is ABSENT from the document.
- [ ] **Direction 3 — no regression for new files.** A brand-new non-compliant file → every finding is in-diff, behaviour matches Profiles v1.
- [ ] Restore `agentCi`; confirm the polygon tree is clean.

---

### Task 8: Review, docs, PR

- [ ] **Independent critic, model PINNED** (`codex --model gpt-5.6-luna`), run SYNCHRONOUSLY, with the file contents PASTED INTO the prompt — codex cannot read files on Windows, and a "could not verify" reply is a non-verdict. Budget several rounds; re-critic every in-place fix.
- [ ] Update `docs/gotchas/profile-gates-must-be-diff-scoped.md` — its "What is STILL not solved" section is exactly what this closes.
- [ ] `CURRENT-STATE.md` (replace, don't append), `SESSION-LOG.md` (prepend), drop the item from `FUTURE-BACKLOG.md`.
- [ ] `npm run typecheck && npx vitest run && npm run build`, then PR → green CI → merge on the operator's word.
