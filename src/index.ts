// Daemon entry. Wires args → conductor. Kept thin (parity spec §2: conductor
// owns the loop; entry only parses flags, constructs every real dependency,
// and starts it). This module is the production composition root — it is
// integration glue that spawns real `claude`/`codex`/`git`, so it is
// deliberately NOT unit-tested; every module it wires already has its own
// unit tests against injected fakes.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { detectRepoRoot } from "./config/config.js";
import { createApiServer } from "./api/server.js";
import { buildProjectConfigView } from "./api/config-view.js";
import { buildProjectRoot, type ProjectRoot } from "./composition/root.js";
import { buildReadSnapshot, createReadCapability } from "./orchestrator/capabilities.js";
import { loadRegistry } from "./registry/registry.js";
import { createProjectAdmin } from "./registry/admin.js";
import { listDirs } from "./fsbrowse/fsbrowse.js";
import { detectAgents } from "./detect/detect-agents.js";
import { detectGit } from "./detect/detect-git.js";
import { probeAgentExtensions } from "./detect/agent-extensions.js";
import { resolveWorkerExe, workerIsolationFlags } from "./config/roles.js";
import { createProjectHub } from "./hub/hub.js";
import { createLogger } from "./util/log.js";
import { createGit } from "./util/git.js";
import { ensureAutodevBranch } from "./util/ensure-branch.js";
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
    // serve is DAEMON-GLOBAL: no cwd binding, no detectRepoRoot (spec §3b).
    const log = createLogger(join(homedir(), ".autodev", "daemon.log"));
    const registryFile = process.env["AUTODEV_REGISTRY"] ?? join(homedir(), ".autodev", "projects.json");

    const hub = createProjectHub<ProjectRoot>({
      loadEntries: async () => (await loadRegistry(registryFile, log)).projects,
      buildRoot: (entry) => buildProjectRoot(entry.path),
      log,
    });

    // Project admin (New Project flow, M3): register/unregister + the folder
    // browser's registry-membership check. Same registry file as the hub, so a
    // registration is visible to hub.list()/get() on the next call.
    const admin = createProjectAdmin({ registryFile, log });

    // Defensive branch-ensure for ALREADY-registered projects (s30 Task 1): a
    // project left on master/main can't run (conductor guard). Best-effort /
    // never-throws — one broken project must not abort the whole daemon start.
    try {
      const { projects } = await loadRegistry(registryFile, log);
      for (const entry of projects) {
        try {
          if (!existsSync(join(entry.path, ".git"))) continue;
          const r = await ensureAutodevBranch(createGit(entry.path), { log });
          if (r.switched) log("INFO", `serve: ${entry.path} -> branch ${r.branch}`);
        } catch (err) {
          log("WARN", `serve: ensure-branch failed for ${entry.path}: ${String(err)}`);
        }
      }
    } catch (err) {
      log("WARN", `serve: branch-ensure startup pass skipped: ${String(err)}`);
    }

    // UI bundle lives with the INSTALL, not any project (closes [ui/serve-uidir-reporoot]):
    // compiled layout is dist/index.js + dist/ui. AUTODEV_UI_DIR overrides (dev runs vite anyway).
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const uiDirCandidate = process.env["AUTODEV_UI_DIR"] ?? join(moduleDir, "ui");
    const uiDir = existsSync(uiDirCandidate) ? uiDirCandidate : undefined;

    const handle = createApiServer({
      projects: {
        list: () => hub.list(),
        get: async (id) => {
          const r = await hub.get(id);
          if (r === null || "error" in r) return r;
          const root = r.root;
          const c = root.cfg;
          return {
            view: {
              repo: root.repo,
              stateDir: root.stateDirAbs,
              onOrchestrate: (intent: string) => root.orchestrator.handleIntent(intent),
              config: buildProjectConfigView(c, root.plannerConfigured),
              // Best-effort extension-visibility scan under the project's CURRENT saved
              // isolation. Thin closure over repoRoot + cfg so the HTTP layer never sees
              // the repoRoot/spawn. model is irrelevant to WHICH extensions load (we kill
              // before any turn); ladder[0] is a safe, cheap pick.
              onScanExtensions: () =>
                probeAgentExtensions({
                  exe: resolveWorkerExe(c),
                  cwd: root.repoRoot,
                  model: c.roles.worker.ladder[0] ?? "haiku",
                  isolationFlags: workerIsolationFlags(c),
                }),
              onApplyOnAccept: (taskId: string) => root.applyOnAccept(taskId),
              // Pre-launch chat (adr/003-safe -- see chat-adapter.ts): `manager` is
              // the project's lazily-built ChatSessionManager (composition/root.ts);
              // `buildSnapshot` gives the chat's opening turn the SAME ReadSnapshot
              // shape `handleIntent` uses, over the SAME repo, so "current state"
              // never drifts between the two call sites.
              chat: {
                manager: root.chat,
                buildSnapshot: () => buildReadSnapshot(createReadCapability(root.repo)),
              },
              ci: root.ci,
              onCiCapability: root.onCiCapability,
            },
          };
        },
      },
      admin: {
        register: (input) => admin.register(input),
        unregister: async (id) => {
          const ok = await admin.unregister(id);
          // The project no longer resolves through the normal routes, so an
          // open chat's cancel route becomes unreachable -- close it here
          // rather than leaving the live claude subprocess for the idle
          // reaper to eventually clean up.
          await handle.closeProjectChat(id);
          return ok;
        },
        rename: (id, name) => admin.rename(id, name),
        updateConfig: async (id, form) => {
          const result = await admin.updateConfig(id, form);
          // config.yaml changed on disk -- drop the cached ProjectRoot (and any stale
          // error) so the NEXT hub.get() rebuilds from the fresh file. An
          // already-in-flight run keeps whatever root it already captured.
          if (result.ok) {
            hub.evict(id);
            // Any open chat was started under the now-stale root/config --
            // close it rather than let it keep running against a root the
            // project no longer uses.
            await handle.closeProjectChat(id);
          }
          return result;
        },
        listDirs: (path) => listDirs(path, { isRegistered: (abs) => admin.isRegistered(abs) }),
        detectAgents: () => detectAgents({}),
        initGit: (path) => admin.initGit(path),
        detectGit: () => detectGit({}),
      },
      ...(uiDir !== undefined ? { uiDir } : {}),
      log,
    });
    const boundPort = await handle.listen(command.port, "127.0.0.1");
    log(
      "INFO",
      `serve: listening at http://127.0.0.1:${boundPort} — registry ${registryFile}${
        uiDir ? "" : ` (API only -- no UI bundle at ${uiDirCandidate})`
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
