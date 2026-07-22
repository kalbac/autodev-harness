import type { ProfileGateRecord } from "../gate/profile-gate-record.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from "./evidence-types.js";

/** What the conductor accumulates during one task iteration. */
export interface EvidenceDraft {
  taskId: string;
  runId: string | null;
  title: string;
  type: string;
  fileSet: string[];
  acceptance: string[];
  successCommands: string[];
  profile: { id: string; version: number } | null;
  outcome: EvidenceRecord["outcome"];
  commit: string | null;
  escalation: { type: string; reason: string } | null;
  rounds: number;
  attempts: number;
  startedAt: string;
  endedAt: string;
  critic: { verdict: "clean" | "broken" | "uncertain"; confidence: number } | null;
  gate: EvidenceRecord["gate"];
  profileGates: ProfileGateRecord[];
  tokens: { worker_total: number; critic_total: number } | null;
}

export interface EvidenceDeps {
  write: (taskId: string, name: string, content: string) => Promise<void>;
  log: (level: string, msg: string) => void;
}

export const EVIDENCE_FILE = "evidence.json";

/** Pure: draft -> record. Findings collapse to counts (see evidence-types.ts). */
export function buildEvidence(d: EvidenceDraft): EvidenceRecord {
  return {
    schema: EVIDENCE_SCHEMA_VERSION,
    task_id: d.taskId,
    run_id: d.runId,
    title: d.title,
    type: d.type,
    declared: { file_set: d.fileSet, acceptance: d.acceptance, success_commands: d.successCommands },
    profile: d.profile,
    outcome: d.outcome,
    commit: d.commit,
    escalation: d.escalation,
    rounds: d.rounds,
    attempts: d.attempts,
    started_at: d.startedAt,
    ended_at: d.endedAt,
    critic: d.critic,
    gate: d.gate,
    profile_gates: d.profileGates.map((g) => ({
      id: g.id,
      status: g.status,
      exit_code: g.exit_code,
      skip_reason: g.skip_reason,
      scope: g.scope,
      files: g.files,
      findings:
        g.findings === null
          ? null
          : {
              // `total` is the tool's FULL count and `in_diff` the surviving,
              // diff-filtered one. They are different numbers and their difference
              // is the file's pre-existing debt -- the whole reason the ledger keeps
              // both. Falling back to the filtered length when `findings_total` was
              // never measured is the honest floor: it can understate the debt, never
              // invent one.
              total: g.findings_total ?? g.findings.length,
              in_diff: g.findings.length,
              unattributed: g.findings.filter((f) => f.unattributed).length,
            },
    })),
    tokens: d.tokens,
  };
}

/**
 * Fail-soft by contract (H6): evidence is bookkeeping ABOUT the enforcement loop
 * and must never be able to fail it. A report assembled over a missing record
 * says so honestly (H1), which is the safe direction; a task escalated because
 * its evidence write failed would not be.
 */
export async function writeEvidence(d: EvidenceDraft, deps: EvidenceDeps): Promise<void> {
  try {
    await deps.write(d.taskId, EVIDENCE_FILE, JSON.stringify(buildEvidence(d), null, 2));
  } catch (err) {
    try {
      deps.log("WARN", `conductor: persisting evidence for ${d.taskId} failed (ignored): ${String(err)}`);
    } catch {
      // A throwing logger inside the catch must not resurrect the failure
      // (docs/gotchas/never-throws-catch-block-logging.md).
    }
  }
}
