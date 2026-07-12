import { z } from "zod";

export const activityKindSchema = z.enum([
  "worker", "gate", "agent_ci", "critic", "merge", "escalation", "run",
]);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activityStatusSchema = z.enum(["running", "ok", "warn", "error"]);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;

export const activityRefSchema = z
  .object({ taskId: z.string().optional(), runId: z.string().optional() })
  .strict();
export type ActivityRef = z.infer<typeof activityRefSchema>;

export const planSpecPreviewSchema = z
  .object({ id: z.string(), title: z.string(), type: z.string(), file_set: z.array(z.string()) })
  .strict();
export type PlanSpecPreview = z.infer<typeof planSpecPreviewSchema>;

const base = { ts: z.number() };

export const threadEntrySchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("operator_msg"), text: z.string() }).strict(),
  z.object({ ...base, type: z.literal("orchestrator_msg"), text: z.string(), milestone: z.string().optional() }).strict(),
  z.object({ ...base, type: z.literal("activity"), kind: activityKindSchema, ref: activityRefSchema, summary: z.string(), status: activityStatusSchema }).strict(),
  z.object({ ...base, type: z.literal("plan"), specs: z.array(planSpecPreviewSchema) }).strict(),
  z.object({ ...base, type: z.literal("run_link"), runId: z.string() }).strict(),
]);
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

export type ThreadEntryInput =
  | Omit<Extract<ThreadEntry, { type: "operator_msg" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "orchestrator_msg" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "activity" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "plan" }>, "ts">
  | Omit<Extract<ThreadEntry, { type: "run_link" }>, "ts">;

export const threadStatusSchema = z.enum(["chatting", "running", "done", "error"]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;

export const threadMetaSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    created_at: z.number(),
    run_id: z.string().optional(),
    status: threadStatusSchema,
  })
  .strict();
export type ThreadMeta = z.infer<typeof threadMetaSchema>;
