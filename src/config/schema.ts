import { z } from "zod";

export const HarnessConfigSchema = z.object({
  stateDir: z.string().default(".autodev"),
  allowedBranchPattern: z.string().default("^autodev/"),

  repoRoot: z
    .object({ markers: z.array(z.string()).default([".git"]) })
    .default({ markers: [".git"] }),

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

  worker: z
    .object({
      ladder: z.array(z.string()).default(["opus", "sonnet", "haiku"]),
      promptHints: z.array(z.string()).default([]),
      exe: z.string().default("claude"),
      maxTurns: z.number().int().positive().default(100),
      timeoutMinutes: z.number().positive().default(20),
      staleMinutes: z.number().positive().default(15),
    })
    .default({}),

  critic: z
    .object({
      exe: z.string().default("codex"),
      model: z.string().default("gpt-5.5"),
      effort: z.string().default("high"),
      retryMax: z.number().int().nonnegative().default(1),
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
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
