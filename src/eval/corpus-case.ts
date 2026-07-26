import { z } from "zod";

import { isPathSafeId } from "../orchestrator/task-spec.js";

/**
 * One Evaluation Corpus case: a seed repo state + an operator intent + the class of
 * outcome the harness is ASSERTED to produce for it. The corpus runner executes each case
 * through the real headless conductor and the aggregator checks the actual `EvidenceRecord`
 * outcome against `expected` — so the corpus proves the harness does the RIGHT thing
 * (commits good work, catches bad work), not merely that it runs.
 *
 * Fail-closed schema discipline (mirrors `report/evidence-types.ts`): `.strict()` so an
 * unknown key makes the case UNREADABLE rather than a partially-trusted pass, and types
 * are derived via `z.infer` (a hand-written `x?: T` does not match `.optional()` under
 * `exactOptionalPropertyTypes`). A malformed case must fail loudly at load, never be run
 * with a silently-defaulted expectation.
 */
export const CORPUS_CASE_SCHEMA_VERSION = 1;

/** Longest id the corpus accepts. The id becomes a path segment under an already-deep
 *  artifacts root, and an unbounded one can push a per-case archive past Windows' MAX_PATH
 *  where long-path support is off (codex R3). Generous for a descriptive kebab-case name --
 *  the shipped corpus's longest is 26. */
export const MAX_CORPUS_CASE_ID_LENGTH = 64;

/**
 * Is this a usable corpus case id? THE single definition, used by the schema below AND by
 * `case-archive.ts`'s own barrier — the point being that the check and the use share one
 * function rather than two hand-kept-in-sync approximations, which is the recurring defect
 * shape of docs/gotchas/validated-one-string-used-another.md. The archive re-checked only
 * `isPathSafeId` while the schema enforced more, so a direct caller could hand the archive an
 * id the corpus itself would have refused (codex R4).
 *
 * Beyond path-safety, a usable id must not END IN A DOT, and both reasons are about the gap
 * between a path-safe STRING and a directory NAME:
 *  - `"."` (and `"...."`) is path-safe, but `join(root, ".")` collapses to `root` ITSELF,
 *    pointing a case's archive directory at the artifacts root (codex R1);
 *  - Windows strips trailing dots from a path segment, so `"case."` and `"case"` are two ids
 *    by any string comparison and ONE directory on disk — the second case's archive would
 *    clear the first's (codex R2).
 */
export function isCorpusCaseId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_CORPUS_CASE_ID_LENGTH && isPathSafeId(id) && !id.endsWith(".");
}

/** The task kinds the corpus spans (per the external architecture review, risk 7).
 *  `docs` was added in Phase 2 for the authored corpus: a documentation-only change is a
 *  distinct behaviour to measure, not a mislabelled feature — it is the case where the
 *  profile's source gates legitimately SKIP, so it proves the harness still commits work
 *  a gate did not judge (and that the skip is logged rather than read as a green). */
export const CorpusCaseType = z.enum([
  "feature",
  "bugfix",
  "migration",
  "integration",
  "security",
  "wc-compat",
  "docs",
]);

export const CorpusCaseSchema = z
  .object({
    schema: z.literal(CORPUS_CASE_SCHEMA_VERSION),
    /** A path-safe segment, because the id NAMES THINGS ON DISK — the run's per-case
     *  artifacts directory, among others. Constraining it here, at the one place a case
     *  enters the system, is what lets every consumer use it verbatim; validating it at
     *  each use site instead is the recurring defect shape of
     *  docs/gotchas/validated-one-string-used-another.md.
     *
     *  `isPathSafeId` alone is NOT enough, and both gaps are about the difference between
     *  a path-safe STRING and a usable directory NAME. A single rule closes both:
     *  **the id must not end in a dot.**
     *   - `"."` (and `"...."`) is path-safe, but `join(root, ".")` collapses to `root`
     *     ITSELF, pointing a case's archive directory at the artifacts root (codex R1).
     *   - Windows strips trailing dots from a path segment, so `"case."` and `"case"` are
     *     two ids by any string comparison and ONE directory on disk — the second case's
     *     archive would clear the first's (codex R2).
     *  Deliberately narrow: an earlier version demanded an alphanumeric character, which
     *  also rejected perfectly usable ids like `"-"` and `"._-"` (codex R2, minor). Only
     *  the trailing dot is actually a problem. */
    id: z
      .string()
      .min(1)
      // The id becomes a path segment under the artifacts root, which is itself already a
      // deep path; an unbounded id can push the per-case archive past Windows' MAX_PATH
      // where long-path support is not enabled (codex R3). 64 is generous for a descriptive
      // kebab-case name -- the shipped corpus's longest is 26. Declared BEFORE the refines:
      // `.refine()` returns a ZodEffects, which has no `.max()`.
      .max(64, "id must be at most 64 characters (it becomes a directory name under the artifacts root)")
      .refine(isPathSafeId, { message: "id must be a path-safe segment (no '/', '\\', '..', or NUL)" })
      .refine((id) => !id.endsWith("."), {
        message:
          "id must not end in a dot ('.' collapses to the parent directory, and Windows strips trailing dots, " +
          "so two such ids can name one directory)",
      }),
    type: CorpusCaseType,
    /** The operator intent handed to the run composer — what the harness should attempt. */
    intent: z.string().min(1),
    /** Path (relative to the corpus root) of the seed repo fixture this case runs against. */
    seed: z.string().min(1),
    /** True when the case PLANTS a defect the harness MUST catch (a subtly-broken change the
     *  gate/critic should reject) — an adversarial case that commits is an ESCAPED DEFECT, the
     *  headline catching-power metric. False for a good case (expected `committed`) or a
     *  genuinely-ambiguous one (expected `escalated` but with no planted defect, so a commit is
     *  merely unexpected, not a defect that escaped). Enforced below: adversarial ⇒ escalated. */
    adversarial: z.boolean(),
    expected: z
      .object({
        // A case expects the harness either to COMMIT the change (a good task the worker can
        // complete and the gate/critic should pass) or to ESCALATE it (an adversarial task
        // the gate/critic must CATCH, or a genuinely-ambiguous one it should park). There is
        // no "rejected" — the harness parks a task, it never rejects it.
        outcome: z.enum(["committed", "escalated"]),
        // For an adversarial case, the escalation type the harness is expected to catch it
        // with (e.g. "disagreement", "constitution", "critic-unavailable"); null when
        // unspecified, and REQUIRED null for a committed case (enforced below).
        escalation_type: z.string().nullable(),
      })
      .strict(),
    /** Why this case exists / which property of the harness it proves. */
    rationale: z.string().min(1),
  })
  .strict()
  // A committed case cannot also name an escalation type — the two are contradictory, and a
  // case carrying both is a malformed expectation the runner could "satisfy" either way.
  .refine((c) => c.expected.outcome === "escalated" || c.expected.escalation_type === null, {
    message: 'a "committed" case must have expected.escalation_type null',
  })
  // An adversarial case plants a defect that must be caught, so it can only expect an
  // escalation — an adversarial case expecting a commit is a contradictory expectation.
  .refine((c) => !c.adversarial || c.expected.outcome === "escalated", {
    message: 'an adversarial case must expect "escalated"',
  });

export type CorpusCase = z.infer<typeof CorpusCaseSchema>;
