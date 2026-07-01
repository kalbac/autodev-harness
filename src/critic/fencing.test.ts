import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withWorkerReportFenced } from "./fencing.js";

const dirsToClean: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adh-fence-"));
  dirsToClean.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("withWorkerReportFenced", () => {
  it("moves the file away while fn runs and restores it (with original content) afterward", async () => {
    const dir = makeTempDir();
    const reportPath = join(dir, "worker-report.md");
    writeFileSync(reportPath, "original content");

    let observedAbsentDuringFn = false;
    const result = await withWorkerReportFenced(reportPath, async () => {
      observedAbsentDuringFn = !existsSync(reportPath);
      return "fn-result";
    });

    expect(observedAbsentDuringFn).toBe(true);
    expect(result).toBe("fn-result");
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe("original content");
  });

  it("restores the file even when fn throws, and propagates the error", async () => {
    const dir = makeTempDir();
    const reportPath = join(dir, "worker-report.md");
    writeFileSync(reportPath, "original content");

    let caught: unknown;
    try {
      await withWorkerReportFenced(reportPath, async () => {
        throw new Error("boom");
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe("original content");
  });

  it("runs fn and returns its value when workerReportPath is null", async () => {
    const result = await withWorkerReportFenced(null, async () => "value-from-fn");
    expect(result).toBe("value-from-fn");
  });

  it("runs fn normally when the path points to a non-existent file (no fencing attempted)", async () => {
    const dir = makeTempDir();
    const reportPath = join(dir, "does-not-exist.md");

    const result = await withWorkerReportFenced(reportPath, async () => "value-from-fn");
    expect(result).toBe("value-from-fn");
    expect(existsSync(reportPath)).toBe(false);
  });
});
