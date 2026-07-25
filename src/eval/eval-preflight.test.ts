import { describe, it, expect } from "vitest";
import { assertTargetQueueIsIdle, createOneShotQueueGuard } from "./eval-preflight.js";
import type { QueueReader } from "./eval-preflight.js";
import type { QueueState } from "../blackboard/repository.js";

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
});
