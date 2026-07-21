import { z } from "zod";

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
  })
  .strict();

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
      .object({ provision: z.array(z.string()).default([]) })
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
