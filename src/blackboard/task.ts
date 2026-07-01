import { parse as parseYaml } from "yaml";
import type { Task } from "./types.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

function toBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(yes|true)$/i.test(v.trim());
  return fallback;
}
function toStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null || v === "") return [];
  return [String(v)];
}

/** Parse a blackboard task file (frontmatter + markdown body) into a Task. */
export function parseTask(content: string, path: string): Task {
  const m = FRONTMATTER.exec(content);
  const fmText = m ? m[1]! : "";
  const body = m ? m[2]! : content;
  const fm = (fmText ? (parseYaml(fmText) as Record<string, unknown>) : {}) ?? {};

  return {
    id: String(fm.id ?? ""),
    title: String(fm.title ?? ""),
    type: String(fm.type ?? ""),
    touches_contract_zone: toBool(fm.touches_contract_zone),
    writes_guard: toBool(fm.writes_guard),
    model: fm.model != null ? String(fm.model) : null,
    success_commands: toStrArray(fm.success_commands),
    forbidden_paths: toStrArray(fm.forbidden_paths),
    max_rounds: fm.max_rounds != null ? Number(fm.max_rounds) : null,
    file_set: toStrArray(fm.file_set),
    depends_on: toStrArray(fm.depends_on),
    contract_zones_touched: toStrArray(fm.contract_zones_touched),
    needs_guard: toBool(fm.needs_guard),
    acceptance: toStrArray(fm.acceptance),
    ...(fm.phase != null ? { phase: String(fm.phase) } : {}),
    body,
    path,
  };
}
