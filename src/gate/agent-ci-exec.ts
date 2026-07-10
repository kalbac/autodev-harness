import spawn from "cross-spawn";

const SIGKILL_GRACE_MS = 2000;
const MAX_REMAINDER_BYTES = 1_000_000;
const WSL_PROBE_TIMEOUT_MS = 5000;

export type AgentCiMode = "native" | "wsl" | "unavailable";
export type AgentCiUnavailableReason = "needs-wsl-on-windows" | "needs-node-in-wsl";

export interface AgentCiCapability {
  mode: AgentCiMode;
  reason?: AgentCiUnavailableReason;
  detail: string; // human string for the UI + escalation
}

/** Thrown by runAgentCiWorkflows when capability is `unavailable`. Propagates through
 *  runGate into the conductor, whose escalation reason becomes `detail` (not the generic
 *  "gate threw -- broken operator config"). */
export class AgentCiUnavailableError extends Error {
  constructor(readonly reason: AgentCiUnavailableReason, readonly detail: string) {
    super(detail);
    this.name = "AgentCiUnavailableError";
  }
}

/** Map a Windows path to its WSL `/mnt/<drive>/...` form. Returns null for a path we
 *  cannot map (UNC, no drive letter) — the caller treats null as `unavailable`. */
export function winToWslPath(winPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return null;
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function shSingleQuote(s: string): string {
  // POSIX single-quote escaping: ' -> '\''
  return s.replace(/'/g, "'\\''");
}

export function buildAgentCiCommand(
  mode: "native" | "wsl",
  opts: { cwd: string; workflow: string },
): { command: string; args: string[] } {
  if (mode === "native") {
    return { command: "npx", args: ["@redwoodjs/agent-ci", "run", "--workflow", opts.workflow, "--json"] };
  }
  const script = `cd '${shSingleQuote(opts.cwd)}' && npx @redwoodjs/agent-ci run --workflow '${shSingleQuote(opts.workflow)}' --json`;
  return { command: "wsl.exe", args: ["-e", "bash", "-lc", script] };
}

export interface WslProbeResult {
  hasDistro: boolean;
  hasNode: boolean;
}

/** Real WSL probe: a distro exists if `wsl.exe -l -q` yields ≥1 non-empty line;
 *  node exists if `wsl.exe -e bash -lc "node -v"` exits 0. Best-effort, bounded. */
export async function probeWslReal(): Promise<WslProbeResult> {
  const listOut = await runProbe("wsl.exe", ["-l", "-q"]);
  // wsl -l -q output is UTF-16LE with interleaved NUL bytes; strip them, then check for any non-empty line.
  const distros = listOut.stdout
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const hasDistro = listOut.exitCode === 0 && distros.length > 0;
  if (!hasDistro) return { hasDistro: false, hasNode: false };
  const nodeOut = await runProbe("wsl.exe", ["-e", "bash", "-lc", "node -v"]);
  return { hasDistro: true, hasNode: nodeOut.exitCode === 0 && /v\d/.test(nodeOut.stdout) };
}

function runProbe(command: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env: process.env });
    } catch {
      done(-1);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      done(-1);
    }, WSL_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { stdout += c; });
    child.on("error", () => { clearTimeout(timer); done(-1); });
    child.on("close", (code) => { clearTimeout(timer); done(code ?? -1); });
    child.stdin?.on("error", () => {});
    child.stdin?.end("");
  });
}

export interface DetectDeps {
  platform?: NodeJS.Platform;
  probeWsl?: () => Promise<WslProbeResult>;
}

export async function detectAgentCiCapability(deps: DetectDeps = {}): Promise<AgentCiCapability> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return { mode: "native", detail: "agent-ci runs natively on this platform" };
  }
  const probe = deps.probeWsl ?? probeWslReal;
  const { hasDistro, hasNode } = await probe();
  if (!hasDistro) {
    return {
      mode: "unavailable",
      reason: "needs-wsl-on-windows",
      detail: "agent-ci gate requires WSL on Windows -- install WSL or run the daemon on Linux/Mac",
    };
  }
  if (!hasNode) {
    return {
      mode: "unavailable",
      reason: "needs-node-in-wsl",
      detail: "agent-ci gate requires Node.js inside your WSL distro -- install node in WSL (e.g. via nvm)",
    };
  }
  return { mode: "wsl", detail: "agent-ci runs via WSL on this Windows host" };
}

// ---- Streaming spawner (native or wsl; the command/args already encode the mode) ----

export interface AgentCiSpawnInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onLine: (line: string) => void;
}

/** Mirrors runNative's / makeStreamingSpawnInit's kill discipline, but streams stdout
 *  line-by-line to `onLine` instead of buffering. Never rejects on non-zero exit;
 *  resolves { exitCode } (a timeout resolves with the killed child's code). */
export type AgentCiSpawner = (input: AgentCiSpawnInput) => Promise<{ exitCode: number }>;

export const spawnAgentCiStream: AgentCiSpawner = (input) =>
  new Promise((resolve) => {
    let remainder = "";
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const resolveOnce = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline); // NOT killTimer: a scheduled SIGKILL must still fire
      resolve({ exitCode });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env });
    } catch {
      resolveOnce(-1);
      return;
    }

    const killChild = (): void => {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
    };
    deadline = setTimeout(() => {
      killChild();
      resolveOnce(-1);
    }, input.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      remainder += chunk;
      let nl: number;
      while ((nl = remainder.indexOf("\n")) !== -1) {
        const line = remainder.slice(0, nl);
        remainder = remainder.slice(nl + 1);
        if (line.trim().length === 0) continue;
        try { input.onLine(line); } catch { /* a bad consumer must never crash the run */ }
      }
      if (remainder.length > MAX_REMAINDER_BYTES) remainder = ""; // memory bound; time bound = deadline
    });
    child.stderr?.on("data", () => {}); // drain to avoid pipe backpressure

    child.on("error", () => {
      if (killTimer) clearTimeout(killTimer);
      resolveOnce(-1);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (remainder.trim().length > 0) {
        try { input.onLine(remainder); } catch { /* ignore */ }
      }
      resolveOnce(code ?? -1);
    });
    child.stdin?.on("error", () => {}); // EPIPE guard
    child.stdin?.end("");
  });
