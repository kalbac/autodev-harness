/**
 * North-star silence predicate -- the fail-closed gate for unattended autonomy
 * (spec 2026-07-23, `adr/004` tenet 4, Principle 10).
 *
 * The north-star is the per-project intent anchor (`.autodev/GOAL.md`): what the
 * project is, why, what it must do, what it must never do. Unattended autonomy must
 * refuse to build a project whose intent is not written down -- so before an
 * overnight drain claims its first task, the conductor asks: is the north-star
 * effectively SILENT?
 *
 * This module is PURE (a string predicate + a shared constant); it does no I/O. The
 * conductor supplies the north-star text (or `null` when it cannot be read) and gates
 * ONLY the unattended path on the result. Attended runs never consult it -- the
 * operator is present to steer a project whose goal is still a stub.
 */

/**
 * The sentinel line the scaffolded `GOAL_STUB` carries in every unfilled section.
 * SHARED with `scaffold.ts` (which imports it to build the stub) so the two can never
 * drift on the exact string -- if they did, a freshly-scaffolded GOAL.md would read as
 * PRESENT and an unattended run would proceed against an unwritten intent. A test
 * (`north-star.test.ts`) pins `isNorthStarSilent(GOAL_STUB) === true` against this.
 */
export const NORTH_STAR_UNFILLED_SENTINEL = "<!-- north-star: unfilled -->";

/**
 * Is the north-star effectively SILENT -- nothing an anti-drift critic could check
 * work against? True when the north-star text is:
 *  - absent (`null` -- not configured, missing on disk, or unreadable: the conductor
 *    maps every "could not read" to `null`, so this is the fail-closed case),
 *  - empty or whitespace-only, or
 *  - still carrying the scaffold's unfilled sentinel in ANY section (the operator
 *    never replaced the stub).
 *
 * Used ONLY to gate unattended autonomy; attended runs never consult it. Fails toward
 * "silent" (the conservative direction, Principle 10): when in doubt, refuse to run
 * unattended rather than build against an intent that may not exist.
 */
export function isNorthStarSilent(intentText: string | null): boolean {
  if (intentText === null) return true;
  if (intentText.trim() === "") return true;
  if (intentText.includes(NORTH_STAR_UNFILLED_SENTINEL)) return true;
  return false;
}
