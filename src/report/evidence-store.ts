import { EvidenceSchema, type EvidenceRecord } from "./evidence-types.js";
import { EVIDENCE_FILE } from "./evidence.js";

/**
 * A task's slot in the ledger. "absent" and "unreadable" stay DISTINCT because
 * they mean different things to a reader: absent is usually a task that predates
 * the ledger or never ran; unreadable is a defect. Folding either into a pass is
 * the fail-open this feature exists to avoid (H1). Note the errno lesson from
 * docs/gotchas/oracle-protected-paths-must-be-worktree-relative.md: a read that
 * FAILS is never evidence of absence -- only a reader that positively reports
 * "no such file" (a `null` return) is.
 */
export type EvidenceSlot =
  | { taskId: string; state: "ok"; record: EvidenceRecord }
  | { taskId: string; state: "absent" }
  | { taskId: string; state: "unreadable"; detail: string };

/** `read` returns the file's text, or `null` when the file does not exist. */
export type EvidenceReader = (taskId: string) => Promise<string | null>;

export async function loadEvidence(taskIds: string[], read: EvidenceReader): Promise<EvidenceSlot[]> {
  const out: EvidenceSlot[] = [];
  for (const taskId of taskIds) {
    let text: string | null;
    try {
      text = await read(taskId);
    } catch (err) {
      out.push({ taskId, state: "unreadable", detail: String(err) });
      continue;
    }
    if (text === null) {
      out.push({ taskId, state: "absent" });
      continue;
    }
    try {
      out.push({ taskId, state: "ok", record: EvidenceSchema.parse(JSON.parse(text)) });
    } catch (err) {
      out.push({ taskId, state: "unreadable", detail: String(err) });
    }
  }
  return out;
}

/** The name a reader implementation must read. Exported so no caller retypes it. */
export { EVIDENCE_FILE };
