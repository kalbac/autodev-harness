import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Critic verdict types + parser — parity spec §3 (verdict.json shape) and §5
 * (tolerant text extraction, run by `invoke-critic.ps1`).
 */

export interface BrokenContract {
  zone: string;
  file: string;
  line: number;
  evidence: string;
}

export interface Verdict {
  verdict: "clean" | "broken" | "uncertain";
  broken_contracts: BrokenContract[];
  notes: string;
  confidence: number;
  diff_sha256?: string; // attached by the wrapper after parsing — never sent to/by codex
}

const BrokenContractSchema = z
  .object({
    zone: z.string(),
    file: z.string(),
    line: z.number(),
    evidence: z.string(),
  })
  .strict();

/**
 * The codex-facing schema (parity §3): strict, 4 required fields, matching
 * the JSON Schema passed to `codex exec --output-schema`
 * (`additionalProperties: false`). `diff_sha256` is deliberately excluded —
 * it is a wrapper-side addition, not something codex ever emits.
 */
export const VerdictSchema = z
  .object({
    verdict: z.enum(["clean", "broken", "uncertain"]),
    broken_contracts: z.array(BrokenContractSchema),
    notes: z.string(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

/**
 * Tolerant verdict extraction — parity §5. Codex output is often surrounded
 * by prose; the PowerShell wrapper extracts the outermost JSON object via
 * the greedy regex `(?s)\{.*\}` (first `{` to last `}`), then parses +
 * schema-validates. Any failure (no braces, invalid JSON, schema mismatch)
 * yields `null` rather than throwing — the caller decides how to react to
 * an unparseable verdict.
 */
export function parseVerdict(text: string): Verdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  const candidate = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return result.data;
}

/**
 * Attaches the diff's SHA-256 hex digest to a parsed verdict — the
 * `-ReuseVerdict` cache key (parity §5). Returns a fresh object so
 * `exactOptionalPropertyTypes` never sees an explicit `undefined` assigned
 * to `diff_sha256`; the input verdict is left untouched.
 */
export function attachDiffSha256(verdict: Verdict, diff: string): Verdict {
  const diff_sha256 = createHash("sha256").update(diff).digest("hex");
  return { ...verdict, diff_sha256 };
}
