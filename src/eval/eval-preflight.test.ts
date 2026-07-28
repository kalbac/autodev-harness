import { describe, it, expect } from "vitest";
import { assertTargetQueueIsIdle, assertAgentCiRunnable, createOneShotQueueGuard } from "./eval-preflight.js";
import type { QueueReader } from "./eval-preflight.js";
import type { QueueState } from "../blackboard/repository.js";
import type { AgentCiCapability } from "../gate/agent-ci-exec.js";

function reader(byState: Partial<Record<QueueState, string[]>>): QueueReader {
  return {
    async listTasks(state: QueueState) {
      return (byState[state] ?? []).map((id) => ({ id }));
    },
  };
}

/** A reader whose contents can change between calls, to model work appearing mid-run. */
function mutableReader(): { reader: QueueReader; set: (byState: Partial<Record<QueueState, string[]>>) => void } {
  let state: Partial<Record<QueueState, string[]>> = {};
  return {
    reader: { async listTasks(s: QueueState) { return (state[s] ?? []).map((id) => ({ id })); } },
    set: (next) => {
      state = next;
    },
  };
}

describe("assertTargetQueueIsIdle", () => {
  it("passes on a fully empty queue", async () => {
    await expect(assertTargetQueueIsIdle(reader({}))).resolves.toBeUndefined();
  });

  it("passes when only terminal states hold tasks -- history is not live work", async () => {
    await expect(
      assertTargetQueueIsIdle(reader({ done: ["old-1", "old-2"], quarantine: ["dead-1"] })),
    ).resolves.toBeUndefined();
  });

  it.each(["pending", "active", "escalated"] as const)("refuses when a task is %s", async (state) => {
    await expect(assertTargetQueueIsIdle(reader({ [state]: ["real-work"] }))).rejects.toThrow(
      new RegExp(`live task\\(s\\) \\[${state}/real-work`),
    );
  });

  it("names the destruction it is preventing, not just the count", async () => {
    await expect(assertTargetQueueIsIdle(reader({ escalated: ["awaiting-decision"] }))).rejects.toThrow(
      /purges the queue and runtime state[\s\S]*would DESTROY this work/,
    );
  });

  it("caps the listed tasks so a huge queue does not produce an unreadable error", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    await expect(assertTargetQueueIsIdle(reader({ pending: many }))).rejects.toThrow(/25 live task\(s\).*, \.\.\.\]/s);
  });
});

describe("createOneShotQueueGuard", () => {
  it("checks on the first call and stops checking once satisfied", async () => {
    const { reader: r, set } = mutableReader();
    const guard = createOneShotQueueGuard(r);

    await guard.check(); // idle
    guard.satisfied(); // the purge happened -- the queue is the corpus's now

    set({ pending: ["corpus-own-task"] });
    await expect(guard.check()).resolves.toBeUndefined();
  });

  it("STAYS ARMED when a check passed but the caller never reported a purge", async () => {
    // The R3 leak: a first attempt that passed the queue check and then threw on the
    // branch/dirty check must not leave a retry unguarded -- nothing was purged yet, so
    // work queued in the meantime is still the operator's.
    const { reader: r, set } = mutableReader();
    const guard = createOneShotQueueGuard(r);

    await guard.check(); // passed; caller then throws before purging -> no satisfied()

    set({ escalated: ["operator-work"] });
    await expect(guard.check()).rejects.toThrow(/live task\(s\) \[escalated\/operator-work/);
  });

  it("keeps refusing across repeated attempts until a purge is actually reported", async () => {
    const guard = createOneShotQueueGuard(reader({ pending: ["blocking"] }));
    await expect(guard.check()).rejects.toThrow();
    await expect(guard.check()).rejects.toThrow();
  });

  // #132 (Fix 5i): the end-of-run leftover-queue purge must run ONLY once the corpus has
  // actually taken ownership of the target's queue -- never on a path where it never did.
  describe("ownsQueue", () => {
    it("starts false -- nothing has been purged yet", () => {
      const guard = createOneShotQueueGuard(reader({}));
      expect(guard.ownsQueue()).toBe(false);
    });

    it("becomes true only after satisfied() -- a passing check alone is not ownership", async () => {
      const guard = createOneShotQueueGuard(reader({}));
      await guard.check();
      expect(guard.ownsQueue()).toBe(false);
      guard.satisfied();
      expect(guard.ownsQueue()).toBe(true);
    });

    it("stays false when the guard never got as far as satisfied() (e.g. a later step threw)", async () => {
      const guard = createOneShotQueueGuard(reader({ pending: ["blocking"] }));
      await expect(guard.check()).rejects.toThrow();
      expect(guard.ownsQueue()).toBe(false);
    });
  });
});

describe("assertAgentCiRunnable", () => {
  function capability(mode: AgentCiCapability["mode"], detail = "detail"): AgentCiCapability {
    return { mode, detail };
  }

  it("passes when gate.agentCi is not enabled, regardless of platform capability", () => {
    expect(() =>
      assertAgentCiRunnable({ enabled: false, hasWorkflows: true, capability: capability("unavailable") }),
    ).not.toThrow();
  });

  it("passes when enabled but no workflows are configured -- the gate step is inert either way", () => {
    expect(() =>
      assertAgentCiRunnable({ enabled: true, hasWorkflows: false, capability: capability("unavailable") }),
    ).not.toThrow();
  });

  it("passes when agent-ci runs natively", () => {
    expect(() =>
      assertAgentCiRunnable({ enabled: true, hasWorkflows: true, capability: capability("native") }),
    ).not.toThrow();
  });

  it("passes when agent-ci runs via WSL", () => {
    expect(() =>
      assertAgentCiRunnable({ enabled: true, hasWorkflows: true, capability: capability("wsl") }),
    ).not.toThrow();
  });

  // The core case (#132): a Windows box with no WSL would otherwise escalate every case
  // for an environment reason and produce a report shaped exactly like a real measurement.
  it("refuses when enabled, workflows are configured, and agent-ci cannot run here", () => {
    expect(() =>
      assertAgentCiRunnable({
        enabled: true,
        hasWorkflows: true,
        capability: capability("unavailable", "agent-ci gate requires WSL on Windows"),
      }),
    ).toThrow(/gate\.agentCi\.enabled/);
  });

  it("names both ways forward in the refusal message", () => {
    try {
      assertAgentCiRunnable({ enabled: true, hasWorkflows: true, capability: capability("unavailable") });
      expect.unreachable();
    } catch (err) {
      const msg = String(err);
      expect(msg).toMatch(/gate\.agentCi\.enabled:\s*false/);
      expect(msg).toMatch(/WSL|Linux|Mac/i);
    }
  });

  it("includes the capability's own detail in the refusal, not a generic message", () => {
    expect(() =>
      assertAgentCiRunnable({
        enabled: true,
        hasWorkflows: true,
        capability: capability("unavailable", "needs Node.js inside your WSL distro"),
      }),
    ).toThrow(/needs Node\.js inside your WSL distro/);
  });
});
