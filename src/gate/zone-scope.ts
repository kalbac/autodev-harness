/**
 * WHICH DIFF LINES A CONTRACT ZONE IS ALLOWED TO SEE — `adr/008` (#140).
 *
 * A contract zone declares `path_globs` ("where this contract lives"),
 * `grep_patterns` and `exact_strings` ("what its values look like"). Until s60 the
 * gate read `path_globs` as ONE ARM OF AN OR: if no changed file matched, the value
 * strings were scanned against every line of the diff anyway, whatever file that
 * line came from. So a change that only DOCUMENTED a contract value counted as
 * TOUCHING the contract, and the gate then demanded a mutation-verified guard for a
 * sentence of prose.
 *
 * That was measured, not theorized. In the s59 corpus run the case
 * `good-docs-overview-note` — whose only changed file is `docs/OVERVIEW.md`, and
 * whose whole task was to document that the plugin registers `test_pickup` and
 * `test_courier` — got `clean` @0.99 from the critic (adr/007 working exactly as
 * designed) and was then escalated `needs-guard` by the machine gate.
 *
 * Two independent narrowings, both operator-decided (s60), because both change what
 * "pass" means:
 *
 *   (a) `path_globs` becomes the SCOPE of the string scan. A zone that declares
 *       where its contract lives is only scanned inside those files. A zone that
 *       declares NO path_globs has not said where it lives, so it keeps today's
 *       repository-wide scan — unchanged, and still the default.
 *   (b) A path the operator declared in `contract.docPaths` (`adr/007`) is outside
 *       zone checking entirely. This closes the same hole for a zone with no
 *       `path_globs` at all, which (a) cannot reach.
 *
 * Both are LENIENCY, so every uncertainty in here resolves toward the strict, old
 * behaviour (Principle 10): an unwalkable diff falls back to one unattributed
 * bucket that every zone sees; a line with no post-image path stays in scope for
 * every zone; a path whose shape cannot be trusted is not treated as a declared doc.
 *
 * What this deliberately does NOT touch: the constitution check
 * (`inv.constitution.path_globs` + `contract.constitutionPaths`). That fence is the
 * stronger guarantee and a declared doc path buys no exemption from it — if a
 * project fences a file outright, documenting it is still a human decision.
 */

import { globMatch } from "../util/glob.js";
import { isPlainRelativePath } from "../util/path-shape.js";
import { diffContentLinesByFile, type DiffFileContent } from "./diff-lines.js";
import type { ContractZone } from "./invariants.js";

export type { DiffFileContent };

/**
 * Attribute the diff's `+`/`-` lines to the file each came from.
 *
 * `fallbackLines` is the flat reading the caller already has
 * (`diffAddedRemovedLines(diffText)`), used when the strict walk THROWS — a
 * truncated or malformed diff, which `diff-lines.ts` refuses to guess at. Falling
 * back to one unattributed bucket reproduces the pre-adr/008 gate exactly (every
 * line in scope for every zone), so a diff the harness cannot parse can never be
 * the reason a zone check was skipped. The alternative — letting the throw escape —
 * would convert a diff-shape problem into a gate crash, which the conductor reports
 * as broken operator config; strictly worse for the same input.
 */
export function attributeDiffLines(diffText: string, fallbackLines: string[]): DiffFileContent[] {
  try {
    return diffContentLinesByFile(diffText);
  } catch {
    return [{ file: null, lines: fallbackLines }];
  }
}

/**
 * Is this path one the operator declared as documentation (`contract.docPaths`)?
 *
 * The shape test is `isPlainRelativePath`, the SAME predicate `adr/007`'s
 * `isDeclaredDocsOnlyChange` applies to the SAME config values — `globMatch` is
 * textual, so `docs/**` matches the string `docs/../includes/class-foo.php`, which
 * names a code file. A path this cannot vouch for is simply not a declared doc,
 * which leaves it fully zone-checked.
 */
export function isDeclaredDoc(path: string, docPathGlobs: string[]): boolean {
  if (typeof path !== "string" || path.trim() === "") return false;
  if (!Array.isArray(docPathGlobs)) return false;
  if (!isPlainRelativePath(path)) return false;
  return docPathGlobs.some((g) => typeof g === "string" && g.trim() !== "" && globMatch(g, path));
}

/**
 * (b) Drop every entry whose file the operator declared as documentation.
 *
 * An UNATTRIBUTED entry (`file === null`) is kept: it is a deleted file's lines, and
 * `adr/007` is explicit that removing documented behaviour never earns the docs
 * narrowing — the attack it keeps closed is "rewrite the documented contract first".
 * Deleting a declared doc that names a contract value therefore still trips the zone,
 * which is the same answer `adr/007` gives one layer up.
 */
export function excludeDeclaredDocs(byFile: DiffFileContent[], docPathGlobs: string[]): DiffFileContent[] {
  if (docPathGlobs.length === 0) return byFile;
  return byFile.filter((e) => e.file === null || !isDeclaredDoc(e.file, docPathGlobs));
}

/**
 * (b), for the file list rather than the lines: the changed files a zone check may
 * consider. Used for `zoneTouched`'s path_globs arm, NEVER for the constitution
 * check — see the module doc.
 */
export function excludeDeclaredDocPaths(changedFiles: string[], docPathGlobs: string[]): string[] {
  if (docPathGlobs.length === 0) return changedFiles;
  return changedFiles.filter((f) => !isDeclaredDoc(f, docPathGlobs));
}

/**
 * (a) The diff lines this zone's string scan may look at.
 *
 * - A zone WITH `path_globs`: only lines from files those globs match, plus every
 *   unattributed line.
 * - A zone WITHOUT `path_globs`: every line. The field is the scope; an absent
 *   scope is not an empty scope, it is "not stated", and the honest reading of
 *   "not stated" is the repository-wide scan the gate has always done.
 */
export function zoneScopedLines(zone: ContractZone, byFile: DiffFileContent[]): string[] {
  if (zone.path_globs.length === 0) {
    return byFile.flatMap((e) => e.lines);
  }
  return byFile
    .filter((e) => e.file === null || zone.path_globs.some((g) => globMatch(g, e.file as string)))
    .flatMap((e) => e.lines);
}
