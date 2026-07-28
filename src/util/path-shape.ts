/**
 * Is this a worktree-relative path with no traversal and no drive/root anchor?
 *
 * `globMatch` is a pure textual matcher: `docs/**` compiles to `^docs/.*$`, which the
 * string `docs/../src/index.php` satisfies while naming a file that is not under `docs/`
 * at all. Git's `--name-only` output never contains a `..` segment, so this is not
 * reachable through the conductor today — but every caller here is guarding an ORACLE
 * decision (what "pass" means), and "unreachable today" is not the standard a leniency
 * gate is held to.
 *
 * It REFUSES rather than normalizes, deliberately. Normalizing would silently accept a
 * path list that should never have contained a traversal segment in the first place; a
 * `..` arriving here means the caller is not passing what its function documents, and
 * the honest response to an input you cannot explain is to decline
 * (`docs/gotchas/boolean-whose-no-means-two-things.md`).
 *
 * Shared rather than duplicated: it began as a private helper of
 * `isDeclaredDocsOnlyChange` (`adr/007`, s59) and `adr/008` needed the identical shape
 * test for the same `contract.docPaths` values one layer down, in the machine gate. A
 * second copy is the repo's most recurring defect shape — a value CHECKED in one
 * normalization and USED in another (`docs/gotchas/validated-one-string-used-another.md`)
 * — so both call sites share this one function instead.
 */
export function isPlainRelativePath(p: string): boolean {
  // A control character (NUL above all) cannot occur in a path git reports, and a NUL
  // in particular truncates the string for any C-level consumer downstream — so
  // `docs/README.md\0src/index.php` would match `docs/**` here and name a different
  // file to something else.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("/")) return false; // POSIX absolute, and UNC `//server/share`
  if (/^[a-zA-Z]:/.test(s)) return false; // Windows drive-anchored, incl. a bare `D:`
  return !s.split("/").includes("..");
}
