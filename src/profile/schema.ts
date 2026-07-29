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
    /**
     * Declares the machine-readable report format this gate's stdout emits, so
     * the harness can parse it, filter it to the diff's ADDED lines, and judge
     * the gate by the filtered finding count instead of the exit code (line-
     * scoped profile gates, `docs/superpowers/plans/2026-07-22-line-scoped-
     * profile-gates.md`). Optional; a gate without `report` behaves exactly as
     * before -- whole-file scoping, verdict from the exit code.
     *
     * A CLOSED enum, not a free string: an unknown format must fail loudly at
     * profile load (a typo or an unimplemented format silently disabling
     * line-scoping is the fail-OPEN this schema exists to prevent), not at gate
     * run time when a parser lookup comes back empty. `"checkstyle"` is the
     * only member today because it is the only format this harness has a
     * parser for (`src/gate/checkstyle.ts`) -- add a member here exactly when a
     * second parser is built, never speculatively.
     */
    report: z.enum(["checkstyle"]).optional(),
    /**
     * A profile-relative path to this gate's DEFAULT ruleset — `adr/010`. Declaring
     * this key is how a profile author marks a gate's standard as OVERRIDABLE: only
     * a gate that declares `ruleset:` can be pointed at a project's own file via
     * `contract.gateRulesets` (`src/config/schema.ts`); a gate without this key
     * (e.g. `composer-validate`) cannot be overridden at all, by construction, not
     * by a separate allow/deny flag.
     *
     * Cross-checked against `{ruleset}` in `run`, in BOTH directions, in
     * `loadProfile` — the identical discipline the `files`/`{files}` and `report`
     * cross-checks already use, and for the identical reason: a `run` containing
     * `{ruleset}` with no `ruleset:` key would ship the literal placeholder text to
     * the tool; a `ruleset:` key whose `run` never mentions `{ruleset}` reads as
     * overridable while nothing the gate actually runs can be overridden.
     *
     * Validated to the SAME normal form `isInvalidProtectedPathEntry` establishes
     * for `protectedPaths` (non-empty, not absolute on any platform, no `..`
     * segment) — plus, deliberately STRICTER, no backslash at all. `protectedPaths`
     * folds `\` to `/` because its entries are later re-probed through
     * `oracle-paths.ts`'s own fold-then-resolve pipeline (a downstream normalization
     * this field has no equivalent of): a ruleset path is joined directly against an
     * anchor directory with `resolve`, which on a POSIX host treats `\` as an
     * ordinary filename byte, not a separator
     * (docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md, leak #6).
     * Refusing the backslash outright here — rather than silently folding it, one
     * more time, in one more place — is what keeps this module from re-deriving
     * that leak in a narrower form; an author who wants a `/`-separated path can
     * simply write one.
     */
    ruleset: z
      .string()
      .superRefine((p, ctx) => {
        if (isInvalidRulesetEntry(p)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `gate 'ruleset' must be a non-blank, profile-relative, forward-slash path (not absolute on any platform, no ".." segment, no backslash): ${JSON.stringify(p)}`,
          });
        }
      })
      .optional(),
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
 * Fail-closed lexical check for a `ruleset:` declaration — used both at profile-
 * load-schema time (above, for the profile author's own default) and by
 * `profile.ts` at `loadProfile` time (for a PROJECT's override,
 * `contract.gateRulesets`, which is a plain `Record<string,string>` at the config-
 * schema layer with no path-shape validation of its own — see
 * `src/config/schema.ts`'s `gateRulesets` doc comment). Exported so both callers
 * share the identical predicate rather than drifting into two near-copies that
 * disagree on some input (`docs/gotchas/validated-one-string-used-another.md`).
 *
 * Refuses: empty, absolute on any platform (`isAbsoluteOnAnyPlatform` above),
 * any `/`-separated segment equal to `..`, any backslash at all, and any glob
 * metacharacter. See the `ruleset:` field doc comment on `ProfileGateSchema` for
 * why this is stricter than `isInvalidProtectedPathEntry`'s fold-then-check
 * treatment of `\`.
 *
 * The glob refusal closes an ORACLE-FENCE ESCAPE found by the review gate, and it
 * is worth stating precisely because the two ends of it look unrelated. A ruleset
 * entry is consumed by `profile.ts` as a LITERAL path — it is `resolve`d, `stat`ed
 * and substituted verbatim into the gate command — but the same string is handed
 * to `resolveOracleSet`, whose `classifyOracleEntry` reads a metacharacter as a
 * PATTERN. On POSIX a file may legitimately be named `rules[1].xml`; declaring it
 * would run the gate against that real file while registering a glob in the fence,
 * and a glob is not obliged to match the literal filename that produced it. The
 * result is a ruleset the worker may rewrite without the fence noticing — the exact
 * protection `adr/010` part (c) exists to provide, defeated by a filename.
 *
 * Refusing the shape at the ENTRY POINT is the fix rather than teaching the fence
 * to special-case source 6, because that is the rule
 * `docs/gotchas/validated-one-string-used-another.md` arrives at after seven
 * instances: state the normal form once, where the value enters, so every consumer
 * downstream is looking at the same thing. A ruleset is one concrete file; there is
 * no legitimate reading in which it is a pattern.
 */
export function isInvalidRulesetEntry(p: string): boolean {
  if (p === "") return true;
  if (isAbsoluteOnAnyPlatform(p)) return true;
  if (p.includes("\\")) return true;
  if (p.split("/").some((seg) => seg === "..")) return true;
  // Deliberately the SUPERSET of what `classifyOracleEntry` treats as glob syntax,
  // not an exact mirror of it: this predicate's job is to guarantee the two
  // consumers can never disagree, and a superset guarantees that even if the
  // fence's own metacharacter set later widens. `{`/`}` are included on the same
  // reasoning although the harness matcher does not implement brace expansion.
  if (/[*?[\]{}]/.test(p)) return true;
  return false;
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
    // `.refine(Number.isSafeInteger)` is NOT redundant with `.int()`: `.int()`
    // accepts 9007199254740993, which JavaScript cannot represent and silently
    // stores as ...992. `parseProfileRef` already refuses such a value on the
    // REFERENCE side, but guarding only one side left the guarantee half-closed
    // (round-6 critic finding): a profile.yaml declaring the unrepresentable
    // number becomes ...992 in memory, a reference pinning ...992 parses cleanly,
    // and `pf.version !== version` then compares equal -- so the loader reports a
    // profile as "resolved exactly as pinned" when the file's own declared decimal
    // says otherwise. Exact pinning is the contract this whole module exists to
    // uphold, so both sides of the comparison have to reject what they cannot
    // represent.
    version: z.number().int().positive().refine(Number.isSafeInteger, {
      message: "profile version must be an exactly representable integer (<= Number.MAX_SAFE_INTEGER)",
    }),
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
  /** The gate's declared report format, or `null` when it declares none (today's
   *  whole-file, exit-code-verdict behaviour, unchanged). See `ProfileGateSchema.
   *  report` for why this is a closed enum rather than a free string. Non-optional
   *  (always `null`, never `undefined`) for the same reason `filesGlob` is: a
   *  resolved/normalized field states its "not declared" case explicitly rather
   *  than leaving callers to distinguish "absent" from "not yet set". */
  report: "checkstyle" | null;
  /**
   * The relative ruleset text ACTUALLY IN FORCE for this gate, or `null` when the
   * gate declares no `ruleset:` key at all. This is the RAW declared text, not a
   * resolved path -- `rulesetPath` below is that. Kept around (rather than
   * discarded once resolved) purely for observability: it is what
   * `GET /projects/:id/guarantees` (`adr/010` Consequences, #138) needs to show
   * "which standard formalized this", alongside `rulesetSource`.
   *
   * "In force" is load-bearing and was learned the expensive way. This field is
   * SEEDED with the profile author's own `ruleset:` value when the gate list is
   * built, and then OVERWRITTEN with the project's declared entry by the
   * `{ruleset}` resolution step whenever an override applies -- so it always
   * agrees with `rulesetSource` and `rulesetPath`, and is always profile-relative
   * for `"profile"` and repoRoot-relative for `"project"`. Reading the seed as
   * final produced a projection that named the PROFILE's file while attributing it
   * to the PROJECT (caught live on the first real repository, not by a test). A
   * consumer must never pair this value with a source it did not come from; the
   * three fields are written together for exactly that reason.
   */
  ruleset: string | null;
  /**
   * Which side supplied the ruleset actually in force for this gate --
   * `"profile"` (the profile author's own default, `ruleset:`'s value resolved
   * against the profile directory) or `"project"` (a project's own declaration,
   * `contract.gateRulesets[id]`, resolved against its `repoRoot` -- `adr/010`).
   *
   * Meaningful ONLY when `ruleset !== null`; for a gate that declares no
   * `ruleset:` key this is always `"profile"` and `rulesetPath` is `""` --
   * inert placeholders, never consulted, because the `{ruleset}`/`ruleset:`
   * cross-check in `loadProfile` guarantees such a gate's `run` can never
   * contain `{ruleset}` to substitute them into.
   */
  rulesetSource: "profile" | "project";
  /**
   * The ABSOLUTE path actually substituted for `{ruleset}` in `run` -- the one
   * value the gate's own tool invocation is judged against. `""` when
   * `ruleset === null` (see `rulesetSource` above for why that placeholder is
   * safe). Deliberately a resolved absolute path, not the raw declared text:
   * `run` is executed with the worktree as `cwd`, so a relative ruleset text
   * would resolve against the WRONG root depending on which side declared it
   * (the profile directory vs a project's `repoRoot`) -- exactly the
   * `[critic/validated-one-string-used-another]` shape this repo has hit
   * repeatedly. Resolving once, here, at load, is what keeps the gate's `run`
   * command correct regardless of which side supplied the ruleset.
   */
  rulesetPath: string;
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
