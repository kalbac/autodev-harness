import { z } from "zod";
import { posix, win32 } from "node:path";

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
  model: z.string().default("gpt-5.6-luna"),
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

  // Attached qualification profile, as "<id>@<version>" (e.g.
  // "wordpress-woocommerce@1"). null = no profile = the whole profile contour is
  // inert (no gate step 1d, no extra oracle paths, no extra provisioning), byte-
  // identical to pre-profile behaviour. Same null-is-a-no-op shape as
  // gate.checkCommand. The reference is RESOLVED (and fail-closed validated) in
  // src/profile/profile.ts, not here: the schema only records the operator's
  // intent, it does not touch the filesystem.
  profile: z.string().nullable().default(null),

  repoRoot: z
    .object({ markers: z.array(z.string()).default([".git"]) })
    .default({ markers: [".git"] }),

  // Gitignored dependency dirs (e.g. vendor, plugins-reference, node_modules)
  // to link into each per-task worktree so a real gate (composer check /
  // phpunit) can run. Deps dirs are always TOP-LEVEL — nesting is unused
  // (YAGNI) and was the root of a nested-stale-link blocker (a nested `a/b`
  // junction under a real `a/` survives a top-level-only stale scan, so
  // recursive cleanup could traverse it). Each entry must therefore be a
  // SINGLE relative path segment: no absolute path, no `..`, and no path
  // separator at all (fail-loud here; the worktree manager guards again at
  // the fs-op site). Empty = off. `isAbsolute` from `node:path` resolves to
  // the HOST platform's semantics only (win32 on Windows, posix elsewhere);
  // check both explicitly so a Windows-style absolute path (`C:\...`) or a
  // UNC path (`\\host\share\...`) is rejected even when the harness runs on
  // Linux/mac, and a POSIX-style absolute path (`/etc`) is rejected even when
  // it runs on Windows (finding 3).
  worktree: z
    .object({
      provision: z
        .array(z.string())
        .superRefine((arr, ctx) => {
          for (const p of arr) {
            if (
              p === "" ||
              p === "." ||
              p === ".." ||
              p.includes("/") ||
              p.includes("\\") ||
              posix.isAbsolute(p) ||
              win32.isAbsolute(p)
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `worktree.provision entry must be a single top-level path segment within the repo (no absolute, no "..", no separator) : ${JSON.stringify(p)}`,
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
      // OPTIONAL local-CI-replay hardening (spec 2026-07-08-agent-ci-gate-hardening).
      // Fully inert unless `enabled` AND a non-empty `workflows` allowlist — mirrors
      // checkCommand's null-is-a-no-op shape. NEVER auto-discovers workflows (a
      // deploy/publish workflow with secrets must never fire pre-merge); the allowlist
      // is explicit. A genuine workflow failure -> RETRY; an agent-ci/Docker infra
      // failure -> the gate step throws -> conductor escalates (see gate.ts step 1c).
      agentCi: z
        .object({
          enabled: z.boolean().default(false),
          workflows: z.array(z.string()).default([]),
          // 10 min: comfortably covers a cold `npx @redwoodjs/agent-ci` download +
          // a real Docker CI job. A run exceeding this is an INFRA failure (escalate),
          // not a job failure (retry).
          timeoutMs: z.number().int().positive().default(600000),
        })
        .default({ enabled: false, workflows: [], timeoutMs: 600000 }),
    })
    .default({
      checkCommand: null,
      skipCheckByDefault: false,
      agentCi: { enabled: false, workflows: [], timeoutMs: 600000 },
    }),

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

  // Ambient-extension isolation for the spawned worker CLI. OFF by default =
  // byte-identical current behavior (the worker inherits the operator's full
  // ~/.claude + project extension set). Each flag maps to a `claude -p` lever
  // (see workerIsolationFlags): `cleanRoom`→`--bare` (master — drops MCP, most
  // skills, most agents; SUBSUMES mcp/skills, so their flags are not also
  // emitted when it is on), `mcp`→`--strict-mcp-config` (drop project/global
  // MCP servers), `skills`→`--disable-slash-commands` (drop skills/slash
  // commands). Critic isolation needs no toggle — its NO-TOOLS preamble is
  // always-on in the prompt.
  isolation: z
    .object({
      worker: z
        .object({
          cleanRoom: z.boolean().default(false),
          mcp: z.boolean().default(false),
          skills: z.boolean().default(false),
        })
        .default({}),
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

  // Unattended overnight autonomy (spec 2026-07-17). Fully inert unless
  // `overnight.enabled` -- attended (the default) behaves exactly as before:
  // escalations park and wait for the operator. When enabled, the overnight
  // supervisor auto-reworks retryable escalations (reply-B) up to
  // `maxAutoReworks` times, then parks. Above the gate only (ADR-004 tenet 6).
  autonomy: z
    .object({
      overnight: z
        .object({
          enabled: z.boolean().default(false),
          maxAutoReworks: z.number().int().nonnegative().default(2),
        })
        .default({ enabled: false, maxAutoReworks: 2 }),
    })
    .default({ overnight: { enabled: false, maxAutoReworks: 2 } }),

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
