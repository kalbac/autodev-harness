import { describe, it, expect, vi } from "vitest";
import { performLaunch } from "./launch.js";

describe("performLaunch", () => {
  it("fires onOrchestrate once and marks in-flight", async () => {
    const inFlight = new Set<string>();
    const onOrchestrate = vi.fn(async () => {});
    const r = await performLaunch({ pid: "p", intent: "build X", onOrchestrate, inFlight, log: () => {} });
    expect(r).toEqual({ accepted: true });
    expect(onOrchestrate).toHaveBeenCalledWith("build X");
  });

  it("rejects a concurrent launch for the same project", async () => {
    const inFlight = new Set<string>(["p"]);
    const r = await performLaunch({ pid: "p", intent: "x", onOrchestrate: async () => {}, inFlight, log: () => {} });
    expect(r).toEqual({ accepted: false, reason: "in_flight" });
  });

  it("rejects when onOrchestrate is undefined", async () => {
    const r = await performLaunch({ pid: "p", intent: "x", onOrchestrate: undefined, inFlight: new Set(), log: () => {} });
    expect(r).toEqual({ accepted: false, reason: "unsupported" });
  });

  it("clears in-flight after the fire-and-forget run settles", async () => {
    const inFlight = new Set<string>();
    let resolveRun: () => void;
    const onOrchestrate = () => new Promise<void>((res) => { resolveRun = res; });
    await performLaunch({ pid: "p", intent: "x", onOrchestrate, inFlight, log: () => {} });
    expect(inFlight.has("p")).toBe(true);
    resolveRun!();
    await new Promise((r) => setImmediate(r));
    expect(inFlight.has("p")).toBe(false);
  });
});
