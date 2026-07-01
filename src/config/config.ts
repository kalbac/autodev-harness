import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

/** Load `<repoRoot>/.autodev/config.yaml`, validate against the schema, apply defaults. */
export async function loadConfig(repoRoot: string): Promise<HarnessConfig> {
  const path = join(repoRoot, ".autodev", "config.yaml");
  let raw: unknown = {};
  if (existsSync(path)) {
    raw = parseYaml(await readFile(path, "utf8")) ?? {};
  }
  const parsed = HarnessConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid .autodev/config.yaml: ${issues}`);
  }
  return parsed.data;
}

/** Walk up from `start` to the nearest ancestor directory containing one of `markers`. */
export function detectRepoRoot(start: string, markers: string[] = [".git"]): string {
  let cur = start;
  for (;;) {
    if (markers.some((m) => existsSync(join(cur, m)))) return cur;
    const parent = dirname(cur);
    if (parent === cur) throw new Error(`repo root not found from ${start} (markers: ${markers.join(", ")})`);
    cur = parent;
  }
}
