/**
 * Protected-oracle-artifact set — `adr/006` Phase 2, closing the executable-input
 * residual Phase 1 deliberately left open (Finding 1 sub-class 2, Finding 4;
 * `wiki/authority-model-audit-2026-07.md`). Phase 1 moved oracle-DEFINITION *reads*
 * (INVARIANTS.md / GUARDS.md parsing, in `composition/root.ts`) to the trusted root,
 * so a worker diff can no longer change what the gate checks. It did NOT stop a
 * worker from EDITING the executable oracle *inputs* it still runs from the
 * worktree by design — the guard test files, the mutation recipes, the agent-ci
 * workflow implementations, and any operator-declared human-only path. This module
 * builds the declaration of exactly which worktree-relative paths are those inputs;
 * `conductor.ts` fingerprints them (pre/post worker) and fences a touch the same way
 * it already fences a stray/forbidden file, but earlier and with a more specific
 * escalation (Principle 14: "the worker does not write its own oracle").
 *
 * Two arms, because they carry genuinely different guarantees (conflating them would
 * overclaim what is actually covered):
 *
 *   - `literals` — glob-free, worktree-relative paths. The conductor fingerprints
 *     these DIRECTLY on the filesystem (`util/fingerprint.ts`'s `snapshot`/
 *     `workerTouched`), so a git-IGNORED oracle file is covered too — `snapshot`
 *     already maps an absent file to `"<absent>"`, so a worker CREATING a
 *     previously-absent oracle literal registers as drift, which is correct: even
 *     though Phase 1 makes a worker-planted oracle file ineffective for what the
 *     gate actually reads, planting one is itself a tamper attempt.
 *   - `globs` — glob patterns, matched only against the git-VISIBLE touched set
 *     (`oracleGlobTouches`, parity with `forbiddenTouches`). A `constitutionPaths`
 *     glob that matches a target-repo-gitignored path stays an accepted residual —
 *     closing it needs a bounded worktree walk, deferred to `FUTURE-BACKLOG.md`.
 *     Every entry this module itself DERIVES (invariants/guards files, recipes,
 *     guard tests, workflow files) is a LITERAL, so the concrete hole the audit
 *     named is closed regardless of this residual.
 *
 * This module owns exactly ONE trusted-root fs READ path (`GUARDS.md`'s content, to
 * enumerate every row) — everything else is an existence/containment PROBE (lstat +
 * realpath), never a parse. In particular `recipe.file` (the application source a
 * mutation recipe mutates) is never read here at all: the GUARDS.md `recipe` COLUMN
 * (the path to the recipe JSON) is the oracle input and is protected; the recipe
 * JSON's OWN `file` field is the code under test and must stay writable, or every
 * guarded zone's own source would become unwritable — the opposite of the point.
 */
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve as pathResolve, win32 as pathWin32 } from "node:path";
import { globMatch, normalizePath } from "../util/glob.js";
import { canonicalPathContains, realpathContains } from "../util/path-contain.js";
import { parseGuardsTable } from "./guards.js";
import { isContractFileConfigured } from "../config/config.js";
import type { HarnessConfig } from "../config/schema.js";

export interface OracleSet {
  /** Glob-free worktree-relative paths. Fingerprinted DIRECTLY on the filesystem
   *  (pre/post worker), so a git-IGNORED oracle file is still covered. */
  literals: string[];
  /** Glob patterns. Matched against the git-visible touched set only. */
  globs: string[];
  /** entry (literal path OR glob pattern) -> human-readable reason it is protected
   *  (escalation evidence). */
  sources: Map<string, string>;
}

/** An entry is a glob iff it contains `*` or `?` (the matcher's only metachars —
 *  see `util/glob.ts`'s `globToRegExp`). `**` still contains `*`, so it classifies
 *  as a glob too. */
export function classifyOracleEntry(entry: string): "glob" | "literal" {
  return /[*?]/.test(entry) ? "glob" : "literal";
}

/**
 * `guard_test` cells may carry a test-runner SELECTOR suffix (e.g.
 * `tests/FooTest.php::testBar`) — strip everything from the first `::` before the
 * cell is usable as a filesystem path. Parity with how the rest of the gate already
 * treats `guard_test` as a path (`cfg.guards.testCommandTemplate`'s `{testFile}`).
 */
function stripSelectorSuffix(guardTest: string): string {
  const idx = guardTest.indexOf("::");
  return idx === -1 ? guardTest : guardTest.slice(0, idx);
}

/**
 * Fold `\` to `/` so a declaration authored on Windows means the SAME path on every
 * platform. Applied to every relative oracle path before it is resolved, probed, or
 * matched, because `path.resolve`/`lstat` on POSIX treat `\` as an ordinary filename
 * byte — so `docs\GUARDS.md` would probe a file literally named `docs\GUARDS.md`
 * (a miss) instead of `docs/GUARDS.md`. Must run AFTER the absolute check (which
 * inspects the raw entry so a lone-backslash drive-rooted form is still caught) and,
 * for a value that could be absolute, only on the confirmed-relative remainder.
 * Applied uniformly to the two contract files, the derived literals, AND the globs so
 * all three probes/matchers see one canonical shape (critic findings, rounds 4-5).
 */
function foldSeparators(p: string): string {
  return p.split("\\").join("/");
}

/** Why a trusted-root probe (`resolveTrustedFile` below) could not read a path.
 *  Kept distinct from a plain `null`/`false` so the fail-closed throws below can
 *  compose an actionable, specific message (Principle 10/14) instead of a vague
 *  "missing" — mirrors `composition/root.ts`'s identically-shaped, non-exported
 *  `OracleUnreadableReason` (Phase 1); duplicated rather than imported because
 *  `gate/` must not depend on `composition/` (wrong dependency direction — see
 *  `util/path-contain.ts`'s own module doc for the same rule applied to the shared
 *  realpath primitive this reuses). */
type TrustedFileUnreadableReason = "absent" | "escaped-root" | "symlinked";

type TrustedFileResolution = { readable: true; path: string } | { readable: false; reason: TrustedFileUnreadableReason };

/**
 * Resolve `<root>/<relPath>` as a trusted-root file and verify FULL realpath
 * containment under `root` — the same discipline as `composition/root.ts`'s
 * `resolveContainedOracleFile` (Phase 1), reimplemented here (not imported: that
 * function is private to `composition/root.ts`, and this module's own contract is
 * to own its ONE trusted-root read path directly rather than reach into the
 * composition layer). Rejects a symlinked LEAF outright (before any realpath
 * containment check) so a symlinked final path component is never trusted even
 * when its target happens to resolve inside `root`.
 */
async function resolveTrustedFile(root: string, relPath: string): Promise<TrustedFileResolution> {
  // `resolve`, not `join`: `join` concatenates an ABSOLUTE second argument onto the
  // root (`join('C:\\repo', 'C:\\repo\\GUARDS.md')` -> `C:\repo\C:\repo\GUARDS.md`),
  // so an absolute `contract.*File` reported the misleading "not readable at the
  // trusted root" instead of resolving. `resolve` absorbs it, and the escape case
  // stays closed because `realpathContains` below still has to pass.
  // Fold `\`->`/` first so a Windows-authored `docs\GUARDS.md` probes the real file on
  // POSIX too, matching `normalizeLiteralEntry` (critic finding, round 5).
  const p = pathResolve(root, foldSeparators(relPath));
  let lst;
  try {
    lst = await lstat(p);
  } catch (err) {
    // Only a genuine "not there" is "absent". An access/IO error (EACCES/EPERM/ELOOP/
    // EIO/...) on an existing contract file must NOT read as absent: for a NOT-explicitly-
    // configured key that path is silently dropped from the protected set (fail open),
    // and for a configured one it should surface as its real cause, not "missing"
    // (critic finding, round 4 -- the same swallow closed in `normalizeLiteralEntry`).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { readable: false, reason: "absent" };
    throw new Error(
      `resolveOracleSet: contract file '${relPath}' could not be probed at the trusted root '${root}' ` +
        `(${code ?? "unknown fs error"}) -- refusing to treat an inaccessible oracle file as absent (adr/006 Phase 2)`,
    );
  }
  if (lst.isSymbolicLink()) return { readable: false, reason: "symlinked" };
  if (!lst.isFile()) return { readable: false, reason: "absent" };
  if (!(await realpathContains(root, p))) return { readable: false, reason: "escaped-root" };
  return { readable: true, path: p };
}

function trustedFileUnreadableClause(root: string, reason: TrustedFileUnreadableReason): string {
  switch (reason) {
    case "absent":
      return `is not readable at the trusted root '${root}'`;
    case "escaped-root":
      return `resolves OUTSIDE the trusted root '${root}' (an intermediate symlinked directory or a '..' path segment escapes it)`;
    case "symlinked":
      return `resolves through a symlink under the trusted root '${root}' (the final path component is a link, not a real file)`;
  }
}

/**
 * Is `entry` absolute on ANY supported platform? — not just the host one.
 *
 * `path.isAbsolute` is the HOST implementation, so on POSIX it answers `false` for
 * every Windows absolute form: a drive path (`D:\repo\x`), a drive-RELATIVE path
 * (`D:x`, which resolves against the drive's own cwd, not the trusted root), and a
 * UNC share (`\\server\share\x`). This harness is a cross-platform product — a
 * config authored on Windows is legitimately loaded by a daemon on Linux — and there
 * the host check would pass such an entry through as an ordinary relative path, which
 * then simply never exists under the worktree: a declared oracle path, silently
 * unprotected (critic finding, round 2). Recognising the foreign syntax explicitly is
 * what keeps the answer platform-INDEPENDENT.
 */
function isAbsoluteOnAnyPlatform(entry: string): boolean {
  // The HOST implementation covers the platform actually running (and on a win32 host
  // it already accepts POSIX-rooted forms). `win32.isAbsolute` adds, on a POSIX host,
  // `D:\x`, `\\server\share\x`, AND the lone-backslash drive-rooted `\foo\bar` that a
  // hand-rolled "two leading separators" regex misses (critic finding, round 3). The
  // regex then adds drive-RELATIVE `D:x`, which `win32.isAbsolute` deliberately calls
  // NOT absolute, yet resolves against that drive's own cwd rather than the repo root
  // -- equally unenforceable, so equally refused.
  return isAbsolute(entry) || pathWin32.isAbsolute(entry) || /^[A-Za-z]:/.test(entry);
}

/**
 * Fail-closed check for an oracle LITERAL entry (Principle 10), returning the entry
 * NORMALIZED to a root-relative, `/`-separated path. A literal that cannot be
 * enforced must never be silently dropped from the set — it throws, so the operator
 * fixes the declaration instead of unknowingly leaving that path unprotected.
 *
 * **The invariant this establishes:** every entry in `OracleSet.literals` is
 * worktree-relative and `/`-separated. It is load-bearing because the set is resolved
 * against the TRUSTED ROOT but fingerprinted against the WORKTREE
 * (`snapshot(wt.path, literals)` → `join(wt.path, entry)`), and `join` does NOT
 * discard an absolute second argument the way `resolve` does — it concatenates,
 * yielding a nonsense path that reads `"<absent>"` both before and after the worker.
 * That was the round-1 critic's fail-OPEN blocker.
 *
 * Three checks, because they catch different problems and only one needs the entry to
 * actually exist yet:
 *
 *   1. ABSOLUTE → REFUSE, on every platform (`isAbsoluteOnAnyPlatform`). Normalizing
 *      a contained absolute path would also work on the host that wrote it, but its
 *      behaviour would then depend on which OS is running — the one thing a
 *      cross-platform enforcement boundary must not do. One uniform rule ("declare
 *      oracle paths relative to the repo root") is both simpler and stricter, and it
 *      matches what Phase 1 already effectively required of `contract.*File`.
 *   2. LEXICAL containment: `path.resolve(root, entry)` collapses `..`/`.` segments
 *      without touching the filesystem, so a `../x` escape is caught even for an
 *      entry that does not exist on disk yet — required because a legitimately
 *      not-yet-created oracle literal (see `OracleSet.literals` doc comment: its
 *      FUTURE creation is what registers as drift) must never throw merely for being
 *      absent.
 *   3. REALPATH containment: probed only once the entry actually resolves to
 *      something — an intermediate ancestor directory can be a symlink that lexically
 *      "looks" contained while its real location is outside `root`
 *      (`docs/gotchas/static-file-serving-symlink-traversal.md`).
 *
 * Note the control flow around `lstat`: ONLY the `lstat` call is guarded, and its
 * failure is the single tolerated outcome ("not created yet"). An error raised by
 * `realpathContains` propagates. An earlier revision wrapped both calls in one
 * `try/catch` and re-threw by matching the message prefix — which meant an fs error
 * from `realpathContains` (EACCES on an intermediate component, say) was swallowed as
 * if the file were merely absent, and the literal joined the set with its containment
 * unproven: the round-1 fail-open in a narrower form (critic finding, round 2).
 * Scoping the `try` is what makes the fail-closed direction structural rather than
 * dependent on an error's text.
 */
async function normalizeLiteralEntry(root: string, entry: string, source: string): Promise<string> {
  if (isAbsoluteOnAnyPlatform(entry)) {
    throw new Error(
      `resolveOracleSet: oracle literal '${entry}' (${source}) is an absolute path -- oracle declarations must be ` +
        `relative to the repo root, because the fence fingerprints them inside a per-task worktree, not at the ` +
        `trusted root; declare it relative (adr/006 Phase 2)`,
    );
  }
  // Fold `\` to `/` BEFORE `resolve`/`relative`/`lstat` (critic finding, round 4). A
  // declaration authored on Windows (`docs\CONSTITUTION.md`) must mean the same file on
  // every platform, but on POSIX `path.resolve` treats `\` as an ordinary FILENAME
  // character -- so it would probe a file literally named `docs\CONSTITUTION.md` (a
  // miss), skip the containment/directory checks as "not created yet", and still emit
  // the `/`-joined key `docs/CONSTITUTION.md`: a declared path enforced against the
  // wrong probe. `\` is a legal POSIX filename byte, but a cross-platform oracle config
  // treating it as a separator is the only coherent reading. The absolute check above
  // already ran on the RAW entry, so a lone-backslash drive-rooted form was refused
  // before this fold could hide it.
  const relEntry = foldSeparators(entry);
  const resolvedRoot = pathResolve(root);
  const resolvedEntry = pathResolve(root, relEntry);
  if (!canonicalPathContains(resolvedRoot, resolvedEntry)) {
    throw new Error(
      `resolveOracleSet: oracle literal '${entry}' (${source}) escapes the trusted root '${root}' via a '..' path segment -- refusing to build an oracle set that cannot be enforced (adr/006 Phase 2)`,
    );
  }

  // Forward slashes, always. `path.relative` emits the HOST separator, so on Windows
  // it would yield `docs\CONSTITUTION.md` -- an entry shape that differs by platform,
  // reads wrong in the escalation evidence, and would not line up with the `/`-keyed
  // git paths the rest of the fence works in. Done by hand rather than via
  // `normalizePath`, which additionally strips leading '.' characters and would
  // mangle `.github/workflows/ci.yml` into `github/workflows/ci.yml`.
  //
  // Computed BEFORE the fs probes so the empty case gets its own specific message:
  // `.` and `docs/..` resolve to the root, which is also a directory, and the
  // directory check below would otherwise answer with the less accurate advice.
  const normalized = relative(resolvedRoot, resolvedEntry).split(/[\\/]/).join("/");
  if (normalized === "") {
    // `.` / `./` / `docs/..` all resolve to the root itself, and `relative(root, root)`
    // is the empty string. `snapshot` SKIPS empty paths outright, so such an entry
    // would be accepted and then protect nothing at all (critic finding, round 3).
    throw new Error(
      `resolveOracleSet: oracle literal '${entry}' (${source}) resolves to the repo root itself, which names no ` +
        `file to fingerprint -- declare a file, or a glob for a subtree (adr/006 Phase 2)`,
    );
  }

  // ONLY a genuine "it is not there" is tolerated. A bare `catch` would fold EACCES /
  // ELOOP / EIO into "absent" and skip the realpath check below, admitting the literal
  // with its containment unproven -- the round-2 fail-open one level narrower (critic
  // finding, round 3). Every other errno is a probe that did not conclude, and an
  // inconclusive probe fails CLOSED (Principle 10).
  let stat: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    stat = await lstat(resolvedEntry);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new Error(
        `resolveOracleSet: oracle literal '${entry}' (${source}) could not be probed at the trusted root '${root}' ` +
          `(${code ?? "unknown fs error"}) -- refusing to admit a path whose containment is unproven (adr/006 Phase 2)`,
      );
    }
    // ENOENT/ENOTDIR: not created yet -- legitimate (see check 3 above).
  }

  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      // `lstat` did not follow the link, so `stat` describes the LINK itself. The
      // conductor's `snapshot`, however, reads through it and hashes the TARGET's
      // content -- so a worker could repoint `tests/Guard.ts -> other.ts` (or swap the
      // target for a same-content file) and the fingerprint would not move, even though
      // the oracle path now resolves somewhere else. Reject the symlinked leaf outright,
      // symmetric with `resolveTrustedFile`'s treatment of the two contract files
      // (critic finding, round 4).
      throw new Error(
        `resolveOracleSet: oracle literal '${entry}' (${source}) is a SYMLINK -- the fence hashes the link target's ` +
          `content, so repointing the link would not register as drift; declare the real file (adr/006 Phase 2)`,
      );
    }
    if (stat.isDirectory()) {
      // `snapshot` hashes file CONTENT: a directory reads `"<unreadable>"` both before
      // and after the worker, so it can never register drift -- a declared path that
      // silently protects nothing. The glob arm is how a whole subtree is declared.
      throw new Error(
        `resolveOracleSet: oracle literal '${entry}' (${source}) is a DIRECTORY -- the fence fingerprints file ` +
          `content, so a directory could never register a change; declare it as a glob ('${entry}/**') instead ` +
          `(adr/006 Phase 2)`,
      );
    }
    if (!stat.isFile()) {
      // Anything that is neither a symlink (handled above) nor a directory (handled
      // above) nor a regular file — a FIFO, socket, or device node. `snapshot` would
      // block or hash unstably on such an object, so it can never give a reliable
      // pre/post fingerprint. Symmetric with `resolveTrustedFile`'s `!isFile()` reject;
      // the only shape admitted into the set is a regular non-symlink file (critic
      // finding, round 6 — a fail-closed hardening, not a worker-exploitable bypass).
      throw new Error(
        `resolveOracleSet: oracle literal '${entry}' (${source}) is not a regular file (a FIFO/socket/device) -- ` +
          `the fence can only fingerprint regular files; declare a real file (adr/006 Phase 2)`,
      );
    }
    if (!(await realpathContains(root, resolvedEntry))) {
      throw new Error(
        `resolveOracleSet: oracle literal '${entry}' (${source}) resolves OUTSIDE the trusted root '${root}' (an intermediate symlinked directory escapes it) -- refusing (adr/006 Phase 2)`,
      );
    }
  }

  return normalized;
}

/**
 * Fail-closed escape check for an oracle GLOB entry (critic finding, round 1 — a
 * silent fail-OPEN). `addGlob` previously accepted any pattern unchecked, so a
 * declaration like `../shared/**` or `D:\repo\outside\**` was stored and then matched
 * against worktree-RELATIVE git paths in `oracleGlobTouches` — it could never match,
 * and the operator's declared protected path was silently unenforced. That is exactly
 * the asymmetry Principle 10 forbids, and it contradicted the fail-closed treatment
 * the literal arm already gave the same `constitutionPaths` config.
 *
 * A glob cannot be realpath-probed (it names a SET of paths, most of which do not
 * exist), so containment here is necessarily LEXICAL: reject an absolute pattern and
 * reject any `..` segment. That is a strictly weaker guarantee than the literal arm's
 * — an intermediate symlinked directory inside the root is not detectable here — and
 * it is deliberately not claimed to be more. Rejecting rather than rewriting keeps the
 * error actionable: the operator re-declares the pattern relative to the repo root.
 *
 * Returns the pattern with `\` folded to `/`. `globMatch` already folds both sides at
 * match time, so a stored backslash glob would still MATCH correctly — but folding
 * here keeps every entry in `OracleSet.globs` (and its `sources` key / evidence line)
 * in the one canonical `/`-shape the literals use, so the two arms cannot drift
 * (critic finding, round 5 — hygiene, not a live hole).
 */
function assertGlobNotEscaping(entry: string, source: string): string {
  // Check the RAW entry, never `normalizePath(entry)`: `normalizePath` strips leading
  // '.'/'/' characters (its documented PS `.TrimStart('./')` parity quirk), which turns
  // '../shared/**' into 'shared/**' and would silently erase the very escape this
  // check exists to catch. Splitting on BOTH separators catches a `..` written either
  // way before the fold.
  const reason = isAbsoluteOnAnyPlatform(entry)
    ? "is an absolute pattern"
    : entry.split(/[/\\]/).some((seg) => seg === "..")
      ? "contains a '..' segment"
      : null;
  if (reason !== null) {
    throw new Error(
      `resolveOracleSet: oracle glob '${entry}' (${source}) ${reason} -- protected globs are matched against ` +
        `worktree-RELATIVE paths, so such a pattern would never match and the path would be silently ` +
        `unprotected; declare it relative to the repo root (adr/006 Phase 2)`,
    );
  }
  return foldSeparators(entry);
}

/**
 * Build the protected-oracle set from the TRUSTED ROOT (never `wt.path` — a worker
 * only ever writes its own worktree, so reading this from anywhere else would let a
 * diff talk the fence into protecting a set the worker itself just edited). Fails
 * CLOSED (throws) on a broken operator declaration; see the per-source notes below
 * and the module doc comment above for what each arm covers and why.
 *
 * Sources, in the order they are added (also the order `docs/superpowers/plans/
 * 2026-07-22-adr006-phase2-executable-input-protected-paths.md` §"What the set
 * contains" lists them):
 *
 *   1. `contract.invariantsFile` / `contract.guardsFile` — inherits Phase 1's
 *      fail-closed contract EXACTLY (`composition/root.ts`'s `loadInvariantsFrom`/
 *      `loadGuardPairsFrom`): explicitly configured (`isContractFileConfigured`)
 *      but unreadable -> THROW (an operator declared an oracle and got none); not
 *      configured + absent -> contributes nothing (no oracle declared is legitimate).
 *      Added whenever readable, configured or not — "always", not gated on any
 *      other flag.
 *   2. Every `GUARDS.md` row's `recipe` and `guard_test` — ALL rows, not merely
 *      `isMutationVerified` ones (deliberately does NOT reuse
 *      `loadGuardPairsFrom`'s filter): an unverified row's test file is still an
 *      oracle input the operator is working toward blessing, and a worker must not
 *      edit it either. `recipe.file` (the code the recipe mutates) is never
 *      protected — see the module doc comment.
 *   3. `gate.agentCi.workflows` — ONLY when `gate.agentCi.enabled`. With agent-ci
 *      off those files are not this harness's oracle, and protecting them would
 *      escalate ordinary CI-maintenance tasks in every project for no gain. Each
 *      entry contributes itself, PLUS its `.github/workflows/<entry>` form when the
 *      entry is a bare filename (no `/` or `\`), PLUS one shared
 *      `.github/workflows/**` glob covering the whole directory.
 *   4. `contract.constitutionPaths` — each entry classified literal-or-glob
 *      (`classifyOracleEntry`) into the matching arm.
 */
export async function resolveOracleSet(
  cfg: HarnessConfig,
  raw: Record<string, unknown>,
  root: string,
): Promise<OracleSet> {
  const literals: string[] = [];
  const globs: string[] = [];
  const sources = new Map<string, string>();

  // Both arms key `sources` (and the arm array) by the NORMALIZED entry, because that
  // is the string the conductor's fence reports as a hit -- an evidence line keyed by
  // the operator's raw declaration would not match the path it escalates on.
  const addLiteral = async (entry: string, source: string): Promise<void> => {
    const normalized = await normalizeLiteralEntry(root, entry, source);
    if (sources.has(normalized)) return; // first source to claim an entry wins the reason
    sources.set(normalized, source);
    literals.push(normalized);
  };
  const addGlob = (entry: string, source: string): void => {
    const normalized = assertGlobNotEscaping(entry, source);
    if (sources.has(normalized)) return;
    sources.set(normalized, source);
    globs.push(normalized);
  };

  // 1. contract.invariantsFile / contract.guardsFile -- Phase 1's fail-closed
  // contract, verbatim. guardsFile's CONTENT is this module's one trusted-root
  // read (needed to enumerate every GUARDS.md row below); invariantsFile only
  // needs the existence/containment probe -- its content is irrelevant here.
  let guardsText: string | null = null;
  for (const key of ["invariantsFile", "guardsFile"] as const) {
    const relPath = cfg.contract[key];
    const resolution = await resolveTrustedFile(root, relPath);
    if (!resolution.readable) {
      if (isContractFileConfigured(raw, key)) {
        throw new Error(
          `resolveOracleSet: contract.${key} is configured ('${relPath}') but ` +
            `${trustedFileUnreadableClause(root, resolution.reason)} -- the oracle fence cannot ` +
            `protect a missing declaration (adr/006 Phase 2)`,
        );
      }
      continue; // not configured + absent -> contributes nothing
    }
    // Through `addLiteral` like every other source, so an ABSOLUTE `contract.*File`
    // is normalized to root-relative too (round-1 critic finding) -- `resolveTrustedFile`
    // above only proves the file is READABLE at the trusted root, not that the string
    // is usable as a worktree-relative fingerprint key.
    await addLiteral(relPath, `contract.${key}`);
    if (key === "guardsFile") {
      guardsText = await readFile(resolution.path, "utf8");
    }
  }

  // 2. GUARDS.md rows -- ALL of them (see doc comment above: NOT `isMutationVerified`-filtered).
  if (guardsText !== null) {
    const rows = parseGuardsTable(guardsText);
    for (const row of rows) {
      if (row.recipe.trim() !== "") {
        await addLiteral(row.recipe, `GUARDS.md recipe (contract_id=${row.contract_id})`);
      }
      if (row.guard_test.trim() !== "") {
        await addLiteral(
          stripSelectorSuffix(row.guard_test),
          `GUARDS.md guard_test (contract_id=${row.contract_id})`,
        );
      }
      // row.recipe.file is NEVER read here -- see module doc comment.
    }
  }

  // 3. gate.agentCi.workflows -- only when the feature is actually enabled.
  if (cfg.gate.agentCi.enabled) {
    for (const entry of cfg.gate.agentCi.workflows) {
      await addLiteral(entry, `gate.agentCi.workflows: ${entry}`);
      if (!entry.includes("/") && !entry.includes("\\")) {
        await addLiteral(`.github/workflows/${entry}`, `gate.agentCi.workflows: ${entry} (resolved under .github/workflows/)`);
      }
    }
    addGlob(".github/workflows/**", "gate.agentCi.enabled");
  }

  // 4. contract.constitutionPaths -- classify each entry into the correct arm.
  for (const entry of cfg.contract.constitutionPaths) {
    if (classifyOracleEntry(entry) === "glob") {
      addGlob(entry, `contract.constitutionPaths: ${entry}`);
    } else {
      await addLiteral(entry, `contract.constitutionPaths: ${entry}`);
    }
  }

  return { literals, globs, sources };
}

/**
 * Glob arm: which git-visible touched paths match a protected glob? Deliberate
 * parity with `util/fingerprint.ts`'s `forbiddenTouches` — same normalize-both-
 * sides discipline (a `./`-prefixed touched path must not slip past a glob that
 * was written without the prefix), same empty-globs fast path.
 */
export function oracleGlobTouches(touched: string[], globs: string[]): string[] {
  const hits: string[] = [];
  if (globs.length === 0) return hits;
  for (const f of touched) {
    const n = normalizePath(f);
    if (globs.some((g) => globMatch(normalizePath(g), n))) hits.push(n);
  }
  return hits;
}
