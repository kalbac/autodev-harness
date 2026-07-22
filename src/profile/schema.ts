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
    protectedPaths: z.array(z.string()).default([]),
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
