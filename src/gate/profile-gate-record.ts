import type { FilteredFinding } from "./finding-filter.js";

/**
 * One profile gate's outcome for ONE task — the single normal form.
 *
 * `status: "skipped"` exists because a skipped gate is a BOUND on what the
 * verdict covers, and an unreported bound reads as coverage. Before this type
 * a skip was only an INFO log line, which meant the Product Qualification
 * Report could not tell "this check passed" from "this check never ran".
 *
 * `scope` is derived from the gate's own declaration, not from what happened:
 *   - `changed-lines`  — the gate declares `report:` (findings filtered to added lines)
 *   - `changed-files`  — the gate declares `files:` but no `report:`
 *   - `whole-project`  — the gate declares neither (e.g. `composer validate`)
 * It is what keeps a line-scoped proof from ever being read as a product-wide one.
 */
export interface ProfileGateRecord {
  id: string;
  status: "green" | "red" | "skipped";
  /** null when skipped — the gate never ran, so there is no exit code to report. */
  exit_code: number | null;
  /** Non-null only when `status === "skipped"`. */
  skip_reason: string | null;
  scope: "changed-lines" | "changed-files" | "whole-project";
  /** The changed files this gate actually ran against; empty for whole-project and skipped. */
  files: string[];
  /** Diff-filtered findings for a `report` gate; null for any other gate. */
  findings: FilteredFinding[] | null;
  /**
   * How many findings the tool reported BEFORE diff-filtering; null for a gate
   * with no report format. Kept alongside `findings` because their difference is
   * the file's pre-existing debt — the number the Product Qualification Report's
   * "not proven" section is built from. Without it the two numbers are always
   * equal by construction and the debt is invisible, which would make a
   * line-scoped green read as a whole-file proof.
   */
  findings_total: number | null;
  /** Raw tool output — feedback fallback and operator debugging. */
  output: string;
}
