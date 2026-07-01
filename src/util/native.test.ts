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

  it("round-trips a multibyte UTF-8 string through stdout without corruption", async () => {
    const payload = "€ ✓ ключ 中";
    const r = await runNative(process.execPath, [
      "-e",
      `process.stdout.write(${JSON.stringify(payload)})`,
    ]);
    expect(r.stdout).toBe(payload);
  });
});
