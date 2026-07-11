import { describe, it, expect } from "vitest";
import { foldCiStatus, initialCiStatus } from "./ci-status.js";

describe("foldCiStatus", () => {
  it("tracks step counts and terminal phase", () => {
    let s = initialCiStatus();
    s = foldCiStatus(s, "ci.yml", { kind: "step-start", job: "b", step: "lint", index: 0 });
    s = foldCiStatus(s, "ci.yml", { kind: "step-finish", job: "b", step: "lint", index: 0, status: "passed" });
    s = foldCiStatus(s, "ci.yml", { kind: "step-finish", job: "b", step: "unit", index: 1, status: "failed" });
    s = foldCiStatus(s, "ci.yml", { kind: "run-finish", status: "failed" });
    expect(s.workflow).toBe("ci.yml");
    expect(s.steps).toEqual({ done: 2, total: 2 });
    expect(s.phase).toBe("failed");
    expect(s.failedSteps).toEqual(["unit"]);
  });
});
