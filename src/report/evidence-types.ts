import { z } from "zod";

/**
 * One task's evidence — the ledger both reports are assembled from.
 *
 * `.strict()` everywhere and an exact `schema` literal: a record this harness
 * cannot fully understand must read as UNREADABLE, never as a partially-trusted
 * pass (Principle 10 — when unsure, fail toward the safe state). A stripped
 * unknown key is exactly how a config once silently reverted to defaults
 * (docs/gotchas/zod-strip-unknown-keys-silent-config-revert.md).
 *
 * Types are derived with `z.infer` rather than hand-written, because
 * `.optional()` under `exactOptionalPropertyTypes` does not mean what a
 * hand-written `x?: T` means (docs/gotchas/zod-optional-exactoptional-derive-types.md).
 * Every field here is REQUIRED and nullable instead of optional, so there is one
 * way to say "not applicable".
 */
export const EVIDENCE_SCHEMA_VERSION = 1;

const ZoneRecord = z
  .object({
    id: z.string(),
    guarded: z.boolean(),
    mutation_passed: z.boolean(),
    blessed: z.boolean(),
  })
  .strict();

const FindingCounts = z
  .object({
    /**
     * The tool's count BEFORE diff-filtering, or `null` for NOT MEASURED.
     *
     * Nullable rather than a number with a floor: a gate that exited 0 was never
     * parsed, so nothing looked at the file, and any number here would be an
     * invention. Substituting `in_diff` (the old behaviour) made `total - in_diff`
     * zero by construction and the pre-existing debt invisible -- "not measured"
     * silently reading as "no debt" is precisely the fail-open this ledger exists
     * to prevent (spec 2026-07-22, `findings.in_diff` vs `total`).
     */
    total: z.number().int().nonnegative().nullable(),
    in_diff: z.number().int().nonnegative(),
    unattributed: z.number().int().nonnegative(),
  })
  .strict();

const ProfileGateEvidence = z
  .object({
    id: z.string(),
    status: z.enum(["green", "red", "skipped"]),
    exit_code: z.number().int().nullable(),
    skip_reason: z.string().nullable(),
    scope: z.enum(["changed-lines", "changed-files", "whole-project"]),
    files: z.array(z.string()),
    findings: FindingCounts.nullable(),
  })
  .strict();

const GateEvidence = z
  .object({
    decision: z.enum(["COMMIT", "RETRY", "ESCALATE"]),
    composer_green: z.boolean(),
    success_green: z.boolean(),
    agent_ci_green: z.boolean(),
    profile_green: z.boolean(),
    constitution_touched: z.array(z.string()),
    zones: z.array(ZoneRecord),
    changed_files: z.array(z.string()),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    schema: z.literal(EVIDENCE_SCHEMA_VERSION),
    task_id: z.string(),
    run_id: z.string().nullable(),
    title: z.string(),
    type: z.string(),
    declared: z
      .object({
        file_set: z.array(z.string()),
        acceptance: z.array(z.string()),
        success_commands: z.array(z.string()),
      })
      .strict(),
    profile: z.object({ id: z.string(), version: z.number().int() }).strict().nullable(),
    outcome: z.enum(["committed", "quarantined", "escalated", "abandoned"]),
    commit: z.string().nullable(),
    escalation: z.object({ type: z.string(), reason: z.string() }).strict().nullable(),
    rounds: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    started_at: z.string(),
    ended_at: z.string(),
    critic: z
      .object({ verdict: z.enum(["clean", "broken", "uncertain"]), confidence: z.number() })
      .strict()
      .nullable(),
    gate: GateEvidence.nullable(),
    profile_gates: z.array(ProfileGateEvidence),
    tokens: z
      .object({ worker_total: z.number().int().nonnegative(), critic_total: z.number().int().nonnegative() })
      .strict()
      .nullable(),
  })
  .strict();

export type EvidenceRecord = z.infer<typeof EvidenceSchema>;
export type ProfileGateEvidenceRecord = z.infer<typeof ProfileGateEvidence>;
