import { z } from "zod";
import { isAbsolute } from "node:path";

// worker role (ladder-shaped — preserves parity §7: multi-tier ladder,
// rate-limit step-down, contract-zone pin to ladder[0]). No `model` key: the
// worker's model choice IS the ladder; per-task `model:` lives on the Task.
const WorkerRoleSchema = z.object({
  adapter: z.string().default("claude"),
  // .min(1): an empty ladder is rejected at config-load (fail early), not left
  // to blow up later in createRouter. A single-element ladder is legitimate
  // (parity §7: e.g. `[sonnet]`, or a `model: haiku` sub-ladder `[haiku]`; the
  // contract-zone pin `ladder[0]` still resolves) — so .min(1), never .min(2).
  ladder: z.array(z.string()).min(1).default(["opus", "sonnet", "haiku"]),
  exe: z.string().optional(), // resolved from adapter default when absent
  maxTurns: z.number().int().positive().default(100),
  timeoutMinutes: z.number().positive().default(20),
  staleMinutes: z.number().positive().default(15),
  promptHints: z.array(z.string()).default([]),
});

// critic role (single-model).
const CriticRoleSchema = z.object({
  adapter: z.string().default("codex"),
  model: z.string().default("gpt-5.5"),
  effort: z.string().default("high"),
  exe: z.string().optional(),
  retryMax: z.number().int().nonnegative().default(1),
});

// agent role (used by orchestrator + planner — no live adapter in P1,
// config-only). A small factory keeps per-role model defaults consistent
// whether the key is absent or `{}`.
const agentRoleSchema = (adapterDefault: string, modelDefault: string) =>
  z
    .object({
      adapter: z.string().default(adapterDefault),
      model: z.string().default(modelDefault),
      effort: z.string().optional(),
      exe: z.string().optional(),
    })
    .default({});

export const HarnessConfigSchema = z.object({
  stateDir: z.string().default(".autodev"),
  allowedBranchPattern: z.string().default("^autodev/"),

  repoRoot: z
    .object({ markers: z.array(z.string()).default([".git"]) })
    .default({ markers: [".git"] }),

  // Gitignored dependency dirs (e.g. vendor, plugins-reference) to link into
  // each per-task worktree so a real gate (composer check / phpunit) can run.
  // Each entry is a relative path WITHIN the repo: it is used as both a link
  // target under repoRoot and a link path under the worktree, and teardown
  // removes it, so an absolute path or a `..` segment is rejected (fail-loud
  // here; the worktree manager guards again at the fs-op site). Empty = off.
  worktree: z
    .object({
      provision: z
        .array(z.string())
        .superRefine((arr, ctx) => {
          for (const p of arr) {
            if (p === "" || isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `worktree.provision entry must be a relative path within the repo (no absolute, no "..") : ${JSON.stringify(p)}`,
              });
            }
          }
        })
        .default([]),
    })
    .default({ provision: [] }),

  gate: z
    .object({
      checkCommand: z.string().nullable().default(null), // e.g. "composer check" / "npm test"
      skipCheckByDefault: z.boolean().default(false),
    })
    .default({ checkCommand: null, skipCheckByDefault: false }),

  guards: z
    .object({ testCommandTemplate: z.string().default("{testFile}") }) // {testFile} placeholder
    .default({ testCommandTemplate: "{testFile}" }),

  antiDrift: z
    .object({
      intentSource: z.string().nullable().default(null),
      headers: z.array(z.string()).default([]), // empty = feed whole file
      everyCommits: z.number().int().positive().default(5),
      model: z.string().default("sonnet"),
    })
    .default({ intentSource: null, headers: [], everyCommits: 5, model: "sonnet" }),

  contract: z
    .object({
      constitutionPaths: z.array(z.string()).default([]),
      invariantsFile: z.string().default("INVARIANTS.md"),
      guardsFile: z.string().default("GUARDS.md"),
    })
    .default({ constitutionPaths: [], invariantsFile: "INVARIANTS.md", guardsFile: "GUARDS.md" }),

  roles: z
    .object({
      orchestrator: agentRoleSchema("claude", "opus"),
      worker: WorkerRoleSchema.default({}),
      critic: CriticRoleSchema.default({}),
      planner: agentRoleSchema("claude", "sonnet"), // reserved id (R2); no live agent in MVP
    })
    .default({}),

  policy: z
    .object({
      heterogeneity: z.enum(["warn", "off"]).default("warn"), // warn when critic family == worker family
    })
    .default({}),

  commit: z
    .object({ typeMap: z.record(z.string()).default({ guard: "test" }), defaultKind: z.string().default("refactor") })
    .default({ typeMap: { guard: "test" }, defaultKind: "refactor" }),

  loop: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      sleepSeconds: z.number().positive().default(30),
      rateLimitBackoffSeconds: z.number().positive().default(600),
      maxSessionHours: z.number().positive().default(8),
    })
    .default({}),

  dirtyFenceIgnore: z
    .array(z.string())
    .default([
      ".autodev/runtime/",
      ".autodev/queue/",
      ".autodev/escalations/",
      ".autodev/conductor.log",
      ".autodev/digest.md",
    ]),
})
  // .strict(): reject unknown top-level keys LOUDLY instead of silently
  // stripping them. This is what turns the flat `worker:`/`critic:` blocks
  // (pre-R3 shape) into a clear config error after the hard-cut to `roles:`,
  // rather than a silent revert-to-defaults behavior change.
  .strict();

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
