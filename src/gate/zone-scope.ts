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
 * bucket that every zone sees; a section with no known path stays in scope for
 * every zone; a path whose shape cannot be trusted is not treated as a declared doc.
 *
 * A diff hunk has TWO sides, and both decide scope. The review gate broke the first
 * version of this twice with one input: a RENAME carries a file's removed lines
 * under the NEW path, so attributing by post-image alone would let
 * `git mv includes/class-x.php docs/x.md` walk a zone's contract values out of the
 * zone that governs them — and (b) would then drop them entirely. Hence: a section
 * is IN SCOPE for a zone when ANY of its paths matches (union, the strict
 * direction), and EXEMPT from a declaration only when EVERY one of them is declared
 * (intersection, also the strict direction). Same reasoning both times — a leniency
 * rule takes the reading that grants less.
 *
 * What this deliberately does NOT touch: the constitution check
 * (`inv.constitution.path_globs` + `contract.constitutionPaths`). That fence is the
 * stronger guarantee and a declared doc path buys no exemption from it — if a
 * project fences a file outright, documenting it is still a human decision.
 */

import { globMatch } from "../util/glob.js";
import { isPlainRelativePath } from "../util/path-shape.js";
import { diffContentLinesByFile, diffNamedPaths, type DiffFileContent } from "./diff-lines.js";
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
    return [{ files: [], lines: fallbackLines }];
  }
}

/**
 * Every path the diff names, either side, deduped and in first-appearance order.
 *
 * `zonesTouchedInDiff` needs a changed-file list and has only the diff to derive it
 * from. Two things it must not do, each found by a review round on this change:
 *
 * - It must include the PRE-image paths (R1): a deletion's post-image is `/dev/null`
 *   and a rename's is a different file, so a post-image-only list silently omits the
 *   very file whose contract just changed.
 * - It must read the DIFF, not the content buckets (R2): a 100%-similarity rename, a
 *   mode-only change and a binary change name files while emitting no `+`/`-` line
 *   at all, so anything derived from attributed lines reports them untouched — while
 *   the gate, whose list comes from `git diff --name-only`, reports them touched.
 *
 * Both are the same failure: the conductor's contract-risk answer contradicting the
 * gate's on one diff.
 *
 * An unparseable diff is reported as `readable: false` and NEVER as an empty path list.
 * That distinction is the whole point of the return type: an empty list means "this diff
 * names no files", while unreadable means "no answer", and a caller that conflates the two
 * silently drops the path arm of the zone check for every truncated diff — which is the
 * `ambiguous-false` shape this repository keeps producing. Each caller states its own
 * fallback for "no answer", and both fall back toward MORE checking, never less.
 */
export type DiffPathScan = { readable: true; paths: string[] } | { readable: false };

export function scanDiffPaths(diffText: string): DiffPathScan {
  try {
    return { readable: true, paths: diffNamedPaths(diffText) };
  } catch {
    return { readable: false };
  }
}

/**
 * The zone check's file list: git's changed files UNIONED with every path the diff
 * names. Used by the GATE, whose `changedFiles` comes from `git diff --name-only`.
 *
 * `--name-only` reports POST-IMAGE paths, so a 100%-similarity rename of a zone file
 * out of its zone reports only the destination — and a section with no hunk body has
 * no lines to scan either, so the zone that governs the value the rename just moved
 * was reported untouched (R3 review finding). The diff's own headers still name the
 * source. Strictly more files, never fewer.
 *
 * A diff that cannot be walked falls back to git's list ALONE, which is exactly the
 * pre-adr/008 gate: unreadable input never removes a file from the check, and never
 * turns a diff-shape problem into a gate crash either.
 */
export function unionDiffNamedPaths(changedFiles: string[], diffText: string): string[] {
  const scan = scanDiffPaths(diffText);
  return scan.readable ? [...new Set([...changedFiles, ...scan.paths])] : changedFiles;
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
 * (b) Drop every section the operator declared as documentation — but only when
 * EVERY path of that section is declared.
 *
 * A rename has two paths, and only the intersection is safe: renaming
 * `includes/class-x.php` to `docs/x.md` names one declared path and one that is not,
 * so its lines stay fully zone-checked. Taking the union instead (exempt if ANY path
 * is declared) would make `git mv` a way to move contract values out of their zone,
 * which is the same class of hole `adr/007` keeps closed one layer up.
 *
 * A section with NO known path is never exempt, for the same reason: an exemption
 * must be earned by a declaration that actually covers the change.
 */
export function excludeDeclaredDocs(byFile: DiffFileContent[], docPathGlobs: string[]): DiffFileContent[] {
  if (docPathGlobs.length === 0) return byFile;
  return byFile.filter((e) => e.files.length === 0 || !e.files.every((f) => isDeclaredDoc(f, docPathGlobs)));
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
 * - A zone WITH `path_globs`: lines from any section ANY of whose paths those globs
 *   match, plus every section with no known path. A rename OUT of the zone therefore
 *   still exposes its removed lines to the zone it left.
 * - A zone WITHOUT `path_globs`: every line. The field is the scope; an absent
 *   scope is not an empty scope, it is "not stated", and the honest reading of
 *   "not stated" is the repository-wide scan the gate has always done.
 */
export function zoneScopedLines(zone: ContractZone, byFile: DiffFileContent[]): string[] {
  if (zone.path_globs.length === 0) {
    return byFile.flatMap((e) => e.lines);
  }
  return byFile
    .filter((e) => e.files.length === 0 || e.files.some((f) => zone.path_globs.some((g) => globMatch(g, f))))
    .flatMap((e) => e.lines);
}
