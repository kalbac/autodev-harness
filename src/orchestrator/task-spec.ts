import { z } from "zod";
import { stringify } from "yaml";
import { parseTask } from "../blackboard/task.js";

/**
 * Mirrors `FileBlackboardRepository`'s private `safePathSegment` guard (that
 * method is private to the frozen repository class, so this is a standalone
 * re-implementation of the same rule, not a shared import). An id must be a
 * single, safe path segment: it becomes a filename under `queue/pending/`.
 *
 * Implemented as a strict allowlist rather than a denylist: an id is safe iff
 * it consists ONLY of `[A-Za-z0-9._-]` characters AND does not contain `..`.
 * This blocks CR/LF/NUL/space/`/`/`\` and any other control or separator
 * character in one rule, instead of enumerating each forbidden character.
 */
const PATH_SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isPathSafeId(segment: string): boolean {
  return PATH_SAFE_ID_PATTERN.test(segment) && !segment.includes("..");
}

/**
 * The sole trust boundary for LLM-authored tasks: `parseTask` (blackboard/task.ts)
 * never validates — it silently defaults every malformed/missing field — and the
 * scheduler only checks deps+disjointness, not field-level well-formedness. This
 * schema is strict on purpose: unknown keys and missing required fields must fail
 * LOUD here, before a task ever reaches `queue/pending/`.
 *
 * Optional-field defaults mirror `parseTask`'s fallbacks exactly (see task.ts:
 * `toBool` -> false, `toStrArray` -> [], `model`/`max_rounds` -> null, `phase`
 * absent-if-undefined) so that a spec omitting a field round-trips to the same
 * `Task` shape `parseTask` would produce for an omitted frontmatter key.
 */
export const TaskSpecSchema = z
  .object({
    id: z
      .string()
      .min(1, "id must be non-empty")
      .refine(isPathSafeId, {
        message: "id must be a path-safe segment (no '/', '\\', '..', or NUL)",
      }),
    title: z.string().min(1, "title must be non-empty"),
    type: z.string().min(1, "type must be non-empty"),
    file_set: z
      .array(z.string().min(1, "file_set entries must be non-empty"))
      .min(1, "file_set must be non-empty"),

    touches_contract_zone: z.boolean().default(false),
    writes_guard: z.boolean().default(false),
    model: z.string().nullable().default(null),
    success_commands: z.array(z.string()).default([]),
    forbidden_paths: z.array(z.string()).default([]),
    max_rounds: z.number().int().nonnegative().nullable().default(null),
    depends_on: z.array(z.string()).default([]),
    contract_zones_touched: z.array(z.string()).default([]),
    needs_guard: z.boolean().default(false),
    acceptance: z.array(z.string()).default([]),
    // No default: `parseTask` only sets `phase` when the frontmatter key is
    // present (`...(fm.phase != null ? { phase: ... } : {})`). Mirroring that
    // exactly means an omitted spec.phase must stay absent, not defaulted.
    phase: z.string().optional(),
    body: z.string().default(""),
  })
  .strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/**
 * Validate an unknown (e.g. LLM-authored JSON) value against `TaskSpecSchema`.
 * Error formatting mirrors `loadConfig`'s style (src/config/config.ts): every
 * offending path + message, joined, so a caller sees ALL problems at once.
 */
export function validateTaskSpec(spec: unknown): TaskSpec {
  const parsed = TaskSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid task spec: ${issues}`);
  }
  return parsed.data;
}

/**
 * Canonical fingerprint over every field `TaskSpec` and the parsed `Task`
 * share (deliberately excludes `path`, which only `Task` has). Used solely
 * to PROVE — not merely assert by construction — that `serializeTask`'s
 * output round-trips through `parseTask` byte-for-byte in meaning.
 */
function fingerprint(x: {
  id: string;
  title: string;
  type: string;
  touches_contract_zone: boolean;
  writes_guard: boolean;
  model: string | null;
  success_commands: string[];
  forbidden_paths: string[];
  max_rounds: number | null;
  file_set: string[];
  depends_on: string[];
  contract_zones_touched: string[];
  needs_guard: boolean;
  acceptance: string[];
  phase?: string | undefined;
  body: string;
}): string {
  return JSON.stringify({
    id: x.id,
    title: x.title,
    type: x.type,
    touches_contract_zone: x.touches_contract_zone,
    writes_guard: x.writes_guard,
    model: x.model,
    success_commands: x.success_commands,
    forbidden_paths: x.forbidden_paths,
    max_rounds: x.max_rounds,
    file_set: x.file_set,
    depends_on: x.depends_on,
    contract_zones_touched: x.contract_zones_touched,
    needs_guard: x.needs_guard,
    acceptance: x.acceptance,
    phase: x.phase ?? null,
    body: x.body,
  });
}

/**
 * Serialize a validated `TaskSpec` into a blackboard task markdown file —
 * the exact inverse of `parseTask` (blackboard/task.ts) for every field this
 * schema mirrors. `parseTask(serializeTask(spec), path)` round-trips.
 *
 * This is PROVEN, not merely asserted by construction: after serializing,
 * the output is parsed back with `parseTask` and compared field-for-field
 * against the input. A pathological value that would otherwise silently
 * produce a corrupt task file (e.g. something YAML's `stringify` cannot
 * losslessly round-trip) throws loud here instead of writing a broken file.
 */
export function serializeTask(spec: TaskSpec): string {
  const frontmatter: Record<string, unknown> = {
    id: spec.id,
    title: spec.title,
    type: spec.type,
    touches_contract_zone: spec.touches_contract_zone,
    writes_guard: spec.writes_guard,
    model: spec.model,
    success_commands: spec.success_commands,
    forbidden_paths: spec.forbidden_paths,
    max_rounds: spec.max_rounds,
    file_set: spec.file_set,
    depends_on: spec.depends_on,
    contract_zones_touched: spec.contract_zones_touched,
    needs_guard: spec.needs_guard,
    acceptance: spec.acceptance,
  };
  // Only emit `phase` when present — an absent key parses back to `undefined`
  // via `fm.phase != null`, matching an unset TaskSpec.phase.
  if (spec.phase !== undefined) frontmatter.phase = spec.phase;

  // `stringify` always ends with a trailing "\n", so the closing fence lands
  // on its own line without any extra newline bookkeeping here.
  const frontmatterText = stringify(frontmatter);
  const serialized = `---\n${frontmatterText}---\n${spec.body}`;

  const back = parseTask(serialized, "");
  if (fingerprint(spec) !== fingerprint(back)) {
    throw new Error(
      "serializeTask: round-trip verification failed (task spec contains a value that does not survive frontmatter serialization)",
    );
  }

  return serialized;
}
