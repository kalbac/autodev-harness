import { describe, it, expect } from "vitest";
import { runNative } from "./native.js";

describe("runNative", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await runNative(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi");
  });

  it("captures a non-zero exit code without throwing", async () => {
    const r = await runNative(process.execPath, ["-e", "process.exit(3)"]);
    expect(r.exitCode).toBe(3);
  });

  it("kills a hung child at timeoutMs and resolves (does not leak or hang)", async () => {
    const started = Date.now();
    // A child that would otherwise run ~30s; the kill deadline must reap it fast.
    const r = await runNative(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      timeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5000); // resolved via the kill, not the 30s runtime
    expect(r.exitCode).not.toBe(0); // killed, so a non-clean exit code (signal / null -> -1)
  });

  it("does not kill a fast child that finishes before timeoutMs", async () => {
    const r = await runNative(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM (never hangs)", async () => {
    const started = Date.now();
    // A child that traps SIGTERM and would otherwise run ~30s. On POSIX the first
    // SIGTERM is ignored, so termination must come from the escalated SIGKILL; on
    // Windows the first kill is already forceful. Either way it must settle fast.
    const r = await runNative(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"],
      { timeoutMs: 300 },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10000); // 300ms + ~2s grace, NOT the 30s runtime
    expect(r.exitCode).not.toBe(0);
  });

  it("captures stderr", async () => {
    const r = await runNative(process.execPath, ["-e", "process.stderr.write('boom')"]);
    expect(r.stderr).toContain("boom");
  });

  it("resolves (does not hang) when the child reads stdin to EOF and no stdin option is given", async () => {
    const r = await runNative(process.execPath, [
      "-e",
      "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0))",
    ]);
    expect(r.exitCode).toBe(0);
  });

  it("resolves without throwing when the child exits before reading a large stdin (EPIPE race)", async () => {
    // The child exits immediately without reading stdin; writing a payload larger
    // than the OS pipe buffer to its now-closed read end raises EPIPE on our
    // stdin write. runNative must swallow that (benign) error and still resolve
    // from the child's exit -- this is the flaky-CI regression (linux/node20).
    const r = await runNative(process.execPath, ["-e", "process.exit(0)"], {
      stdin: "x".repeat(1_000_000),
    });
    expect(r.exitCode).toBe(0);
  });

  it("round-trips a multibyte UTF-8 string through stdout without corruption", async () => {
    const payload = "€ ✓ ключ 中";
    const r = await runNative(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(payload)})`,
    ]);
    expect(r.stdout).toBe(payload);
  });

  // Windows-only regression: a PATH command that resolves to a `.cmd`/`.bat`
  // shim (like the npm-global `codex` critic, or `npm` itself) must be spawnable
  // by bare name. node's own `spawn` returns ENOENT here; cross-spawn resolves it
  // via PATH+PATHEXT. On POSIX this is uninteresting, so it is skipped there.
  it.runIf(process.platform === "win32")(
    "spawns a Windows .cmd shim by bare name (cross-spawn resolution)",
    async () => {
      const r = await runNative("npm", ["--version"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
  );
});
