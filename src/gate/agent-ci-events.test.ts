import { describe, it, expect } from "vitest";
import { parseAgentCiEvent, deriveWorkflowVerdict, type AgentCiEvent } from "./agent-ci-events.js";

describe("parseAgentCiEvent", () => {
  it("parses a run.start line keyed by `event`", () => {
    const ev = parseAgentCiEvent('{"event":"run.start","ts":"2026-07-10T00:00:00Z","runId":"r1"}');
    expect(ev).toEqual({ kind: "run-start", runId: "r1" });
  });

  it("parses a step.finish with status + durationMs", () => {
    const ev = parseAgentCiEvent('{"event":"step.finish","job":"build","step":"npm test","index":2,"status":"passed","durationMs":1234}');
    expect(ev).toEqual({ kind: "step-finish", job: "build", step: "npm test", index: 2, status: "passed", durationMs: 1234 });
  });

  it("parses the terminal run.finish", () => {
    expect(parseAgentCiEvent('{"event":"run.finish","status":"failed"}')).toEqual({ kind: "run-finish", status: "failed" });
  });

  it("falls back to the legacy `type` key when `event` is absent", () => {
    expect(parseAgentCiEvent('{"type":"run.finish","status":"passed"}')).toEqual({ kind: "run-finish", status: "passed" });
  });

  it("maps a non-JSON log line to { kind: 'other' }", () => {
    expect(parseAgentCiEvent("Pulling image ghcr.io/actions/actions-runner...")).toEqual({ kind: "other" });
  });

  it("maps an unrecognized JSON event to { kind: 'other' }", () => {
    expect(parseAgentCiEvent('{"event":"cache.hit","key":"x"}')).toEqual({ kind: "other" });
  });

  it("parses a job.start with runner + workflow", () => {
    expect(parseAgentCiEvent('{"event":"job.start","job":"build","runner":"ubuntu-latest","workflow":"ci.yml"}'))
      .toEqual({ kind: "job-start", job: "build", runner: "ubuntu-latest", workflow: "ci.yml" });
  });

  it("parses a step.start", () => {
    expect(parseAgentCiEvent('{"event":"step.start","job":"build","step":"lint","index":0}'))
      .toEqual({ kind: "step-start", job: "build", step: "lint", index: 0 });
  });

  it("parses a job.finish with status", () => {
    expect(parseAgentCiEvent('{"event":"job.finish","job":"build","status":"failed","durationMs":50}'))
      .toEqual({ kind: "job-finish", job: "build", status: "failed", durationMs: 50 });
  });

  it("maps an empty line and a JSON array/null to { kind: 'other' }", () => {
    expect(parseAgentCiEvent("   ")).toEqual({ kind: "other" });
    expect(parseAgentCiEvent("[1,2,3]")).toEqual({ kind: "other" });
    expect(parseAgentCiEvent("null")).toEqual({ kind: "other" });
  });
});

describe("deriveWorkflowVerdict", () => {
  const ev = (e: AgentCiEvent): AgentCiEvent => e;

  it("returns 'infra' when there is no terminal run-finish event", () => {
    const events = [ev({ kind: "run-start" }), ev({ kind: "job-start", job: "build" })];
    expect(deriveWorkflowVerdict(events)).toEqual({ outcome: "infra", failedSteps: [] });
  });

  it("returns 'passed' on a passed run-finish", () => {
    const events = [ev({ kind: "run-finish", status: "passed" })];
    expect(deriveWorkflowVerdict(events)).toEqual({ outcome: "passed", failedSteps: [] });
  });

  it("returns 'failed' with the failing step names on a failed run", () => {
    const events = [
      ev({ kind: "step-finish", job: "build", step: "lint", index: 0, status: "passed" }),
      ev({ kind: "step-finish", job: "build", step: "unit tests", index: 1, status: "failed" }),
      ev({ kind: "run-finish", status: "failed" }),
    ];
    expect(deriveWorkflowVerdict(events)).toEqual({ outcome: "failed", failedSteps: ["unit tests"] });
  });

  it("last run-finish wins (a late 'failed' after a 'passed' reads as failed)", () => {
    const events = [ev({ kind: "run-finish", status: "passed" }), ev({ kind: "run-finish", status: "failed" })];
    expect(deriveWorkflowVerdict(events).outcome).toBe("failed");
  });
});
