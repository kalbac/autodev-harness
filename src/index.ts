// Daemon entry. Wires args → conductor. Kept thin (parity spec §2: conductor
// owns the loop; entry only parses flags, constructs every real dependency,
// and starts it). This module is the production composition root — it is
// integration glue that spawns real `claude`/`codex`/`git`, so it is
// deliberately NOT unit-tested; every module it wires already has its own
// unit tests against injected fakes.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { detectRepoRoot } from "./config/config.js";
import { createApiServer } from "./api/server.js";
import { buildProjectRoot } from "./composition/root.js";
import type { ConductorRunOptions } from "./conductor/conductor.js";

/** Parse a `--max-iterations` value; a non-positive-integer must fail LOUD, never
 * silently disable the limit (NaN would make the conductor's `iterations >= max`
 * guard perpetually false). */
function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** `--once` / `--max-iterations <n>` / `--max-iterations=<n>` from `process.argv.slice(2)`. */
function parseArgs(argv: string[]): ConductorRunOptions {
  let once = false;
  let maxIterations: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--once") {
      once = true;
    } else if (arg === "--max-iterations") {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error("--max-iterations: missing value (expected a positive integer)");
      }
      maxIterations = parsePositiveInt(val, arg);
      i++;
    } else if (arg.startsWith("--max-iterations=")) {
      maxIterations = parsePositiveInt(arg.slice("--max-iterations=".length), "--max-iterations");
    }
  }

  return {
    ...(once ? { once } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  };
}

type CliCommand =
  | { mode: "run"; runOpts: ConductorRunOptions }
  | { mode: "orchestrate"; intent: string }
  | { mode: "serve"; port: number };

/** Default bind port for `serve` when `--port` is omitted. */
const DEFAULT_SERVE_PORT = 4319;

/** `--port <n>` / `--port=<n>` from the args after `serve`. Mirrors `--max-iterations` parsing style. */
function parseServeArgs(argv: string[]): { port: number } {
  let port = DEFAULT_SERVE_PORT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--port") {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error("--port: missing value (expected a positive integer)");
      }
      port = parsePositiveInt(val, arg);
      i++;
    } else if (arg.startsWith("--port=")) {
      port = parsePositiveInt(arg.slice("--port=".length), "--port");
    }
  }

  return { port };
}

/**
 * Top-level CLI dispatch. `orchestrate <intent...>` runs the LLM orchestrator
 * over the operator's intent (decompose → enqueue → bounded trigger); `serve
 * [--port N]` boots the read-only dashboard API (+ static UI bundle when built)
 * bound to loopback only; anything else is the default deterministic run mode,
 * honoring `--once` / `--max-iterations`. The remaining args after `orchestrate`
 * are joined so both `orchestrate "build X"` and `orchestrate build X` work.
 */
function parseCli(argv: string[]): CliCommand {
  if (argv[0] === "orchestrate") {
    const intent = argv.slice(1).join(" ").trim();
    if (intent === "") {
      throw new Error('orchestrate: missing intent (usage: orchestrate "<what to build>")');
    }
    return { mode: "orchestrate", intent };
  }
  if (argv[0] === "serve") {
    return { mode: "serve", ...parseServeArgs(argv.slice(1)) };
  }
  return { mode: "run", runOpts: parseArgs(argv) };
}

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));

  if (command.mode === "serve") {
    // Multi-project serve is wired in a LATER task (hub + registry). For THIS
    // task keep serve single-project so the extraction lands green:
    const repoRoot = detectRepoRoot(process.cwd());
    const root = await buildProjectRoot(repoRoot);
    const uiDirCandidate = join(repoRoot, "dist", "ui");
    const uiDir = existsSync(uiDirCandidate) ? uiDirCandidate : undefined;
    const handle = createApiServer({
      projects: {
        list: async () => [{ id: "local", name: "local", path: repoRoot, status: "ready" }],
        get: async (id) =>
          id === "local"
            ? {
                view: {
                  repo: root.repo,
                  stateDir: root.stateDirAbs,
                  onOrchestrate: (i: string) => root.orchestrator.handleIntent(i),
                },
              }
            : null,
      },
      ...(uiDir !== undefined ? { uiDir } : {}),
      log: root.log,
    });
    const boundPort = await handle.listen(command.port, "127.0.0.1");
    root.log(
      "INFO",
      `serve: listening at http://127.0.0.1:${boundPort} (orchestrate endpoint enabled)${
        uiDir ? "" : ` (API only -- no UI bundle found at ${uiDirCandidate})`
      }`,
    );
    return; // the listening server keeps the event loop alive; do not tear it down
  }

  const repoRoot = detectRepoRoot(process.cwd());
  const root = await buildProjectRoot(repoRoot);

  if (command.mode === "orchestrate") {
    const result = await root.orchestrator.handleIntent(command.intent);
    root.log("INFO", `orchestrate: ${result.enqueued.length} task(s) enqueued; triggered=${result.triggered}`);
    for (const t of result.enqueued) root.log("INFO", `  - ${t.id} -> ${t.path}`);
    return;
  }
  await root.conductor.run(command.runOpts);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
