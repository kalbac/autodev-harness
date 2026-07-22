import { describe, it, expect } from "vitest";
import { renderExecutionReport, renderQualificationReport } from "./render.js";
import { buildExecutionReport } from "./execution-report.js";
import { buildQualificationReport } from "./qualification-report.js";

describe("renderQualificationReport", () => {
  it("NEVER emits a bare 'qualified' verdict — the summary carries profile, range and counts (H3)", () => {
    const doc = buildQualificationReport({ from: "aaa", to: "bbb", commits: [] }, []);
    const md = renderQualificationReport(doc);
    expect(md).toContain("aaa..bbb");
    expect(md).toContain("proven on change");
    expect(md).toContain("not proven");
    expect(md).not.toMatch(/^\s*qualified\s*$/im);
  });

  it("does not leak execution vocabulary (H5)", () => {
    const md = renderQualificationReport(buildQualificationReport({ from: "a", to: "b", commits: [] }, []));
    for (const word of ["token", "round", "attempt", "confidence"]) {
      expect(md.toLowerCase()).not.toContain(word);
    }
  });
});

describe("renderExecutionReport", () => {
  it("does not leak product vocabulary (H5)", () => {
    const md = renderExecutionReport(buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, [], () => null));
    for (const word of ["finding", "qualif", "debt", "proven"]) {
      expect(md.toLowerCase()).not.toContain(word);
    }
  });

  it("states evidence completeness", () => {
    const md = renderExecutionReport(
      buildExecutionReport({ runId: "run-1", intent: "x", at: 0 }, [{ taskId: "t1", state: "absent" }], () => null),
    );
    expect(md).toMatch(/evidence.*0 of 1/i);
  });
});
