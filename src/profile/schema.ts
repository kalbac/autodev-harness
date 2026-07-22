import { z } from "zod";
import { posix, win32 } from "node:path";

/**
 * One executable product gate declared by a profile.
 *
 * `files` + the `{files}` placeholder are what make a gate DIFF-SCOPED, and that
 * is not a convenience — it is what makes the gate mean anything. Measured on the
 * real polygon: the WPCS ruleset reports 7069 pre-existing errors across the whole
 * tree and 8 on the single file a task actually changed. A whole-tree gate would
 * therefore be red on every run regardless of what the worker wrote: it would
 * block everything and prove nothing, and its verdict would carry no information
 * about the diff under judgement. Every other check in this harness is
 * diff-scoped (the gate's `resolveScope`, `zonesTouchedInDiff`); a whole-tree
 * profile gate was the odd one out.
 *
 * A gate WITHOUT `files` is whole-project by design (e.g. `composer validate`,
 * which judges a manifest, not a file set) and always runs.
 */
export const ProfileGateSchema = z
  .object({
    id: z.string().min(1),
    run: z.string().refine((s) => s.trim() !== "", { message: "gate 'run' must not be blank" }),
    /** Glob selecting which changed files this gate applies to (e.g. `**\/*.php`).
     *  Required iff `run` contains `{files}`; cross-checked in `loadProfile`. */
    files: z.string().min(1).optional(),
    /**
     * Exit codes that mean "this gate ran and found something worker-fixable" — a
     * genuine RED. Optional; omitted means the gate uses the conservative default
     * of `[1]` (see `ResolvedGate.redExitCodes` for why the default is a single
     * code, not "any non-zero"). When declared, must be non-empty: an empty array
     * would silently mean "no exit code is ever red", which is not what an author
     * writing `redExitCodes: []` could plausibly have intended -- fail loud instead
     * of guessing.
     */
    redExitCodes: z.array(z.number().int().positive()).nonempty().optional(),
  })
  .strict();

/**
 * Rejects anything but a single top-level path segment: not empty, not `.`, not
 * `..`, no `/` or `\`, and not absolute on EITHER platform. This is the EXACT
 * predicate `src/config/schema.ts`'s `worktree.provision` enforces (see its
 * `superRefine`, checked against both `posix.isAbsolute` and `win32.isAbsolute`
 * because a config authored on Windows is legitimately loaded on Linux and vice
 * versa) -- deliberately duplicated here rather than imported, because
 * `src/config/schema.ts` is not a file this module owns and that superRefine is
 * not exported. `src/composition/root.ts` unions `requires.provision` straight
 * into the same worktree manager `worktree.provision` feeds
 * (`provision: [...new Set([...cfg.worktree.provision, ...(profile?.provision ??
 * [])])]`), so a profile author who is not the project operator must not be able
 * to hand the worktree manager an entry the operator's OWN config would have been
 * refused for. Keep this in lockstep with `src/config/schema.ts`'s superRefine by
 * hand if that predicate ever changes.
 */
function isInvalidProvisionEntry(p: string): boolean {
  return p === "" || p === "." || p === ".." || p.includes("/") || p.includes("\\") || posix.isAbsolute(p) || win32.isAbsolute(p);
}

/**
 * Is `entry` absolute on ANY supported platform, not just the host running this
 * process? This harness is a cross-platform product -- a profile authored on
 * Windows is legitimately loaded by a daemon on Linux -- so `posix.isAbsolute`
 * alone would miss a Windows drive path (`C:\outside`) or UNC share, and
 * `win32.isAbsolute` alone would miss nothing extra on a POSIX host but the
 * reverse omission (checking only the host's own implementation) is exactly the
 * gap this closes. Also recognises a drive-RELATIVE form (`D:x`), which
 * `win32.isAbsolute` deliberately calls NOT absolute (it resolves against that
 * drive's own current directory) yet is equally unenforceable as a
 * worktree-relative path, so equally refused.
 *
 * Mirrors `src/gate/oracle-paths.ts`'s identically-named, non-exported
 * `isAbsoluteOnAnyPlatform` -- duplicated rather than imported, for the same
 * reason `isInvalidProvisionEntry` above duplicates `src/config/schema.ts`'s
 * predicate: `gate/` is not a module `profile/` owns, and the function is not
 * exported from it.
 *
 * EXPORTED (round-4 critic fix): `profile.ts`'s raw-`run`-string absolute-path
 * check (guarding against a hard-coded machine-specific path like
 * `--standard=C:\somewhere\phpcs.xml`, which is unportable the moment the
 * harness is installed on a different machine) needs this exact predicate.
 * Rather than adding a THIRD copy alongside this one and `oracle-paths.ts`'s,
 * `profile.ts` imports this one -- it already lives in a module `profile/`
 * owns, so the "don't reach into `gate/`" reason for duplicating in the first
 * place does not apply here.
 */
export function isAbsoluteOnAnyPlatform(entry: string): boolean {
  return posix.isAbsolute(entry) || win32.isAbsolute(entry) || /^[A-Za-z]:/.test(entry);
}

/**
 * Fail-closed lexical check for a `protectedPaths` entry: refuses an empty
 * string, an absolute path on either platform, any path containing a `..`
 * segment, or -- round-4 critic fix -- any entry that lexically resolves to
 * NOTHING (the declaring profile directory itself): `.`, `./`, `foo/..`, or any
 * other shape whose segments fully cancel out.
 *
 * This is a HARDENING, not the closing of an open hole -- say so honestly.
 * `src/gate/oracle-paths.ts`'s `resolveOracleSet` already rejects an absolute or
 * `..`-escaping `protectedPaths` entry fail-closed (via its `normalizeLiteralEntry`
 * / `assertGlobNotEscaping`), at the point it actually builds the oracle set from
 * the profile's declared paths, so a bad entry was never silently accepted into
 * an unenforceable set. The reason to also check it HERE, at profile load, is
 * purely about WHEN and HOW the operator finds out: a broken declaration should
 * fail loud immediately, naming the offending profile, rather than surface later
 * as an opaque failure while building a task's oracle set.
 *
 * The empty-normalization case (round-4 finding) is exactly that surface-later
 * gap in a narrower form: `protectedPaths: ["."]` passed every check above (not
 * empty, not absolute, no literal `..` segment) yet `normalizeLiteralEntry`
 * computes `relative(root, root)` === `""` for it and throws "resolves to the
 * repo root itself" the first time a task actually builds an oracle set --
 * which is exactly the "later, opaque, per-task" failure mode this load-time
 * check exists to prevent. Detecting it here requires no `root` (unlike
 * `normalizeLiteralEntry`, which resolves against one): resolving the entry
 * against ANY anchor and checking whether the result is that same anchor is a
 * purely lexical property of the string, so `posix.normalize` against an
 * implicit `.` anchor is enough -- it collapses `.`/`..` segments exactly like
 * `path.resolve` does, without needing a real filesystem root to resolve
 * against.
 */
function isInvalidProtectedPathEntry(p: string): boolean {
  if (p === "") return true;
  if (isAbsoluteOnAnyPlatform(p)) return true;
  if (p.split(/[\\/]/).some((seg) => seg === "..")) return true;
  // Fold `\` to `/` first (mirrors `oracle-paths.ts`'s `foldSeparators`) so a
  // Windows-authored entry is judged identically on every platform -- `posix.
  // normalize` treats `\` as an ordinary filename byte, not a separator.
  const folded = p.split("\\").join("/");
  // `posix.normalize` preserves a trailing slash on the input ('./' stays
  // './', not '.') -- strip it before comparing, since "the whole path
  // collapses to nothing" must catch './' the same way it catches '.'.
  const normalized = posix.normalize(folded).replace(/\/+$/, "");
  return normalized === "." || normalized === "";
}

/**
 * `profile.yaml` — the on-disk shape of a qualification profile.
 *
 * `.strict()` everywhere for the same reason the harness config root is strict
 * (docs/gotchas/zod-strip-unknown-keys-silent-config-revert.md): a profile that
 * declares a facet this version does not implement (`criticRubrics:`,
 * `release:`) must fail LOUDLY, never load with that facet silently dropped —
 * "qualified by <profile>" would otherwise claim proof that never ran.
 */
export const ProfileFileSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    requires: z
      .object({
        provision: z
          .array(z.string())
          .superRefine((arr, ctx) => {
            for (const p of arr) {
              if (isInvalidProvisionEntry(p)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `requires.provision entry must be a single top-level path segment within the repo (no absolute, no "..", no separator) : ${JSON.stringify(p)}`,
                });
              }
            }
          })
          .default([]),
      })
      .strict()
      .default({ provision: [] }),
    gates: z.array(ProfileGateSchema).default([]),
    /**
     * Worktree-relative oracle paths this profile protects (see
     * `ResolvedProfile.protectedPaths`). Validated lexically at load
     * (`isInvalidProtectedPathEntry`) so a broken declaration fails loud here,
     * naming the profile -- see that function's doc comment for why this is a
     * hardening rather than the closing of an open hole.
     */
    protectedPaths: z
      .array(z.string())
      .superRefine((arr, ctx) => {
        for (const p of arr) {
          if (isInvalidProtectedPathEntry(p)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `protectedPaths entry must be a non-empty, worktree-relative path (not absolute on any platform, no ".." segment): ${JSON.stringify(p)}`,
            });
          }
        }
      })
      .default([]),
  })
  .strict();

export type ProfileFile = z.infer<typeof ProfileFileSchema>;

/**
 * A gate with `{profile}` already expanded to an absolute path.
 *
 * `{files}` is deliberately NOT expanded here: the changed-file set is not known
 * until a task has actually run, so it stays a placeholder in `run` and is
 * substituted per-invocation by the gate runner.
 */
export interface ResolvedGate {
  id: string;
  run: string;
  /** Glob selecting the changed files this gate applies to; null = whole-project
   *  (the gate runs on every task and `run` contains no `{files}`). */
  filesGlob: string | null;
  /**
   * Exit codes that mean RED (a genuine, worker-fixable finding). Defaults to
   * `[1]` when the profile does not declare one.
   *
   * The default is a single code, not "any non-zero", because non-zero exits are
   * not all the same kind of failure. PHPCS exits 3 on a processing error (bad
   * ruleset, unreadable file); `composer validate` exits 3 when there is no
   * manifest to validate at all (measured -- see profiles/wordpress-woocommerce
   * for the composer-validate numbers). Reading either of those as a
   * worker-fixable RED would have the conductor RETRY forever against a defect
   * that is not in the diff: the environment is broken, not the code. `0` is
   * pass; a declared red code is a genuine finding; anything else means the tool
   * could not do its job, and `classifyGateExit` (profile.ts) treats that as
   * "unrunnable" so the caller escalates instead of looping. The conservative
   * direction here is deliberate: escalating a genuinely-red run costs one
   * operator glance, while looping a worker on an unfixable environment costs an
   * unbounded number of runs.
   */
  redExitCodes: number[];
}

/** A profile that has been located, validated and expanded. */
export interface ResolvedProfile {
  id: string;
  version: number;
  /** Absolute path of `<harnessRoot>/profiles/<id>`. */
  dir: string;
  gates: ResolvedGate[];
  /** Worktree-relative oracle paths this profile protects. */
  protectedPaths: string[];
  /** Top-level dirs the profile needs linked into each worktree. */
  provision: string[];
}
