import type { TaskSpec } from "../orchestrator/task-spec.js";
import type { PlanSpecPreview } from "./thread-types.js";

export function toPlanPreview(specs: TaskSpec[] | undefined): PlanSpecPreview[] {
  if (!specs) return [];
  return specs.map((s) => ({ id: s.id, title: s.title, type: s.type, file_set: [...s.file_set] }));
}
