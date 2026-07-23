// Daemon entry. Wires args → conductor. Kept thin (parity spec §2: conductor
// owns the loop; entry only parses flags, constructs every real dependency,
// and starts it). This module is the production composition root — it is
// integration glue that spawns real `claude`/`codex`/`git`, so it is
// deliberately NOT unit-tested; every module it wires already has its own
// unit tests against injected fakes.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { detectRepoRoot, loadConfig } from "./config/config.js";
import { createApiServer } from "./api/server.js";
import { buildProjectConfigView } from "./api/config-view.js";
import { buildProjectRoot, type ProjectRoot } from "./composition/root.js";
import { buildReadSnapshot, createReadCapability } from "./orchestrator/capabilities.js";
import { loadRegistry } from "./registry/registry.js";
import { createProjectAdmin } from "./registry/admin.js";
import { ensureContractStubs } from "./registry/scaffold.js";
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
import { loadSettings, saveSettings, defaultSettingsFile } from "./settings/settings.js";
import { countOptedIn } from "./settings/opt-in-count.js";

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
  | { mode: "serve"; port: number }
  | { mode: "report-run"; runId: string }
  | { mode: "report-qualify"; from?: string; to?: string }
  | { mode: "report-morning"; since?: string };

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

const REPORT_USAGE =
  "usage: report run <runId> | report qualify [--from <sha>] [--to <sha>] | report morning [--since <ISO>]";

/** `--from <sha>` / `--from=<sha>` (and the same for `--to`) from the args after
 *  `report qualify`. Mirrors the `--port` / `--max-iterations` parsing style: a flag
 *  with no value is a LOUD usage error, never a silently-dropped bound. */
function parseQualifyArgs(argv: string[]): { from?: string; to?: string } {
  let from: string | undefined;
  let to: string | undefined;

  const take = (flag: "--from" | "--to", i: number): string => {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("-")) {
      throw new Error(`${flag}: missing value (expected a commit-ish)`);
    }
    return val;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--from") {
      from = take("--from", i);
      i++;
    } else if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
    } else if (arg === "--to") {
      to = take("--to", i);
      i++;
    } else if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length);
    } else {
      throw new Error(`report qualify: unexpected argument ${JSON.stringify(arg)} (${REPORT_USAGE})`);
    }
  }

  // Spread-built so an omitted flag is ABSENT, never an explicit `undefined`
  // (exactOptionalPropertyTypes).
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/** `report run <runId>` / `report qualify [--from <sha>] [--to <sha>]` /
 *  `report morning [--since <ISO>]`. Exported for the CLI-parse test. */
export function parseReportArgs(argv: string[]): CliCommand {
  const verb = argv[0];
  if (verb === "run") {
    const runId = (argv[1] ?? "").trim();
    if (runId === "") {
      throw new Error(`report run: missing run id (${REPORT_USAGE})`);
    }
    return { mode: "report-run", runId };
  }
  if (verb === "qualify") {
    return { mode: "report-qualify", ...parseQualifyArgs(argv.slice(1)) };
  }
  if (verb === "morning") {
    const argv2 = argv.slice(1);
    let since: string | undefined;
    for (let i = 0; i < argv2.length; i++) {
      const arg = argv2[i];
      if (arg === "--since") {
        const val = argv2[i + 1];
        if (val === undefined || val.startsWith("-")) {
          throw new Error("--since: missing value (expected an ISO timestamp)");
        }
        since = val;
        i++;
      } else if (arg !== undefined && arg.startsWith("--since=")) {
        since = arg.slice("--since=".length);
      } else {
        throw new Error(`report morning: unexpected argument ${JSON.stringify(arg ?? "")} (${REPORT_USAGE})`);
      }
    }
    // Validate at the boundary: an unparseable `--since` must be a LOUD error, never a
    // silently-ignored filter (the pure builder falls back to no-filter on a NaN sinceMs).
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw new Error(`report morning: --since must be an ISO timestamp, got ${JSON.stringify(since)}`);
    }
    return { mode: "report-morning", ...(since !== undefined ? { since } : {}) };
  }
  throw new Error(`report: unknown subcommand ${JSON.stringify(verb ?? "")} (${REPORT_USAGE})`);
}

/**
 * Top-level CLI dispatch. `orchestrate <intent...>` runs the LLM orchestrator
 * over the operator's intent (decompose → enqueue → bounded trigger); `serve
 * [--port N]` boots the read-only dashboard API (+ static UI bundle when built)
 * bound to loopback only; `report run <runId>` / `report qualify` print the two
 * reports as Markdown; anything else is the default deterministic run mode,
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
  if (argv[0] === "report") {
    return parseReportArgs(argv.slice(1));
  }
  return { mode: "run", runOpts: parseArgs(argv) };
}

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));

  if (command.mode === "serve") {
    // serve is DAEMON-GLOBAL: no cwd binding, no detectRepoRoot (spec §3b).
    const log = createLogger(join(homedir(), ".autodev", "daemon.log"));
    const registryFile = process.env["AUTODEV_REGISTRY"] ?? join(homedir(), ".autodev", "projects.json");
    const settingsFile = defaultSettingsFile(homedir());

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
        // Self-healing contract-stub migration (adr/006 Phase 1 Finding 2): an
        // already-scaffolded project from BEFORE the fail-closed loader shipped
        // has `contract.guardsFile`/`invariantsFile` CONFIGURED but the file was
        // never written -- root.ts's loaders now THROW on that combination,
        // escalating every task as "broken -- operator config". Own try/catch,
        // same isolation as the branch-ensure step above -- `ensureContractStubs`
        // is itself best-effort/never-throws, but `loadConfig` (to get `cfg`) can.
        // NOTE: this only runs under `serve` -- the bare `run` CLI verb is NOT
        // healed (kept out of scope; an operator hitting this via `run` still
        // gets the actionable fail-closed throw naming the missing path, which
        // is self-diagnosing).
        try {
          const cfg = await loadConfig(entry.path);
          await ensureContractStubs(entry.path, cfg, log);
        } catch (err) {
          log("WARN", `serve: ensureContractStubs failed for ${entry.path}: ${String(err)}`);
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
              // Reply-B (rework) re-queued a task to pending/. Trigger a bounded
              // drain so it actually runs (carrying the critic's persisted
              // objection) instead of waiting for an unrelated pool trigger.
              // R1-thin: a pure `trigger` of the already-enqueued pool. Fire-and-
              // forget + best-effort (the conductor logs its own run errors to
              // conductor.log; a rejection here must never surface to the reply
              // response). See [rework/reply-b-drops-critic-feedback].
              onReplyRework: (taskId: string) => {
                void root.conductor.run({ drain: true }).catch(() => {});
                // Re-arm the narrator for a thread parked `blocked` on this
                // task's escalation so the re-run is narrated live again
                // ([narrator/escalated-run-not-terminal]). Fire-and-forget +
                // best-effort: the reply's 200 must not depend on it.
                void root.rearmNarratorForTask(id, taskId).catch(() => {});
              },
              // Pre-launch chat (adr/003-safe -- see chat-adapter.ts): `manager` is
              // the project's lazily-built ChatSessionManager (composition/root.ts);
              // `buildSnapshot` gives the chat's opening turn the SAME ReadSnapshot
              // shape `handleIntent` uses, over the SAME repo, so "current state"
              // never drifts between the two call sites.
              chat: {
                manager: root.chat,
                buildSnapshot: () => buildReadSnapshot(createReadCapability(root.repo)),
              },
              // Live-orchestrator threads (adr/004): pre-launch chat service +
              // post-launch narrator. `onOrchestrate` reuses the SAME R1-thin
              // launcher the /orchestrate route uses; the launch-guard set is a
              // FRESH per-project Set (thread-launch single-flight is separate
              // from the HTTP /orchestrate route's set -- acceptable because the
              // orchestrator's handleIntent has its own intent-level dedup).
              // buildThreads memoizes, so only the first Set is ever captured.
              threads: root.buildThreads({
                onOrchestrate: (intent: string) => root.orchestrator.handleIntent(intent),
                inFlight: new Set<string>(),
              }),
              ci: root.ci,
              onCiCapability: root.onCiCapability,
              // On-demand Product Qualification Report (spec 2026-07-22 D4). Thin
              // closure over the project's repoRoot + blackboard -- the HTTP layer
              // never sees a git handle. Rejects (never returns an empty report)
              // when the commit range cannot be resolved.
              onQualificationReport: (range) => root.qualificationReport(range),
              // The stored Execution Report, read through the composition root so
              // its filename keeps exactly ONE builder (`executionReportPath`).
              readExecutionReportJson: (runId) => root.readExecutionReportJson(runId),
              // On-demand Morning Report (spec 2026-07-23): reconciles the overnight
              // decision journal against the live blackboard and narrates it via the
              // orchestrator model. GET-only (a read, not an action) -- unwrap to the
              // report doc itself, which is what `GET .../morning-report` returns.
              onMorningReport: (opts) => root.morningReport(opts).then(({ report }) => report),
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
      settings: {
        read: async () => {
          const s = await loadSettings(settingsFile, log);
          const { projects } = await loadRegistry(registryFile, log);
          const counts = await countOptedIn(projects.map((p) => p.path));
          return { overnight: s.overnight, optedInProjects: counts.optedIn, totalProjects: counts.total };
        },
        write: async (next) => {
          await saveSettings(settingsFile, next);
          const { projects } = await loadRegistry(registryFile, log);
          const counts = await countOptedIn(projects.map((p) => p.path));
          return { overnight: next.overnight, optedInProjects: counts.optedIn, totalProjects: counts.total };
        },
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

  if (command.mode === "report-run") {
    // Refresh first so a run that finished under an older build (or whose report
    // write was interrupted) still yields one; `refreshReports` skips any run that
    // already has a report and never throws.
    await root.refreshReports();
    const markdown = await root.readExecutionReport(command.runId);
    if (markdown === null) {
      throw new Error(
        `report run: no execution report for '${command.runId}' -- the run has no manifest, or it is not finished yet`,
      );
    }
    printMarkdown(markdown);
    return;
  }

  if (command.mode === "report-qualify") {
    const { markdown } = await root.qualificationReport({
      ...(command.from !== undefined ? { from: command.from } : {}),
      ...(command.to !== undefined ? { to: command.to } : {}),
    });
    printMarkdown(markdown);
    return;
  }

  if (command.mode === "report-morning") {
    const { markdown } = await root.morningReport({
      ...(command.since !== undefined ? { since: command.since } : {}),
    });
    printMarkdown(markdown);
    return;
  }
  // Overnight autonomy (spec 2026-07-17): runOrSupervise drives the escalation supervisor
  // (drain + auto-rework/park sweep) when overnight is enabled, else a plain bounded run.
  // Either way it receives the operator's `runOpts` so no run option is silently dropped.
  await root.runOrSupervise(command.runOpts);
  // The CLI `run` path's report refresh: ONCE, after the bounded run has resolved --
  // never inside the conductor's iteration loop, because a report describes a run
  // that has FINISHED. Never throws by contract (spec 2026-07-22 H6-style: reporting
  // is bookkeeping about the loop and must not be able to fail it).
  await root.refreshReports();
}

/** Print a report body to stdout with exactly one trailing newline. */
function printMarkdown(markdown: string): void {
  process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

// Only run the daemon when this module is the actual process entry point --
// NOT when it is `import`ed (e.g. by src/index.test.ts for `parseReportArgs`).
// Without this guard, importing this file for its pure CLI-parsing helpers
// would also fire off the real `main()` (real config load, real subprocess
// spawns) as an unintended side effect of loading the test file.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
