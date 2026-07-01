import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerAdapter, WorkerResult, WorkerRunInput } from "./adapter.js";

export interface FakeWorkerAdapterOptions {
  /**
   * When set, `run()` writes this content to `worker-report.md` inside
   * `input.runtimeDir` before resolving — so downstream conductor tests can
   * exercise report routing without a real worker process.
   */
  reportContent?: string;
  /** Optional spy — invoked with the run input before the result is returned. */
  onRun?: (input: WorkerRunInput) => void;
}

/**
 * A scripted `WorkerAdapter` for tests and other in-process callers. Returns
 * a fixed `WorkerResult` and, optionally, writes a fixed `worker-report.md`
 * so callers that read the report separately (the conductor) have something
 * to parse.
 */
export class FakeWorkerAdapter implements WorkerAdapter {
  constructor(
    private readonly result: WorkerResult,
    private readonly options: FakeWorkerAdapterOptions = {},
  ) {}

  async run(input: WorkerRunInput): Promise<WorkerResult> {
    this.options.onRun?.(input);
    if (this.options.reportContent !== undefined) {
      await mkdir(input.runtimeDir, { recursive: true });
      await writeFile(join(input.runtimeDir, "worker-report.md"), this.options.reportContent);
    }
    return this.result;
  }
}
