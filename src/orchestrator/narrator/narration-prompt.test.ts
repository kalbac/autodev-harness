import { describe, it, expect } from "vitest";
import { buildNarrationPrompt, buildMidRunReplyPrompt } from "./narration-prompt.js";

describe("narration prompts", () => {
  it("includes the trigger and asks for short prose without JSON", () => {
    const p = buildNarrationPrompt(
      [{ ts: 1, type: "operator_msg", text: "build X" } as any],
      [{ kind: "task_done", taskId: "t1", title: "add endpoint" } as any],
    );
    expect(p).toContain("add endpoint");
    expect(p.toLowerCase()).toContain("short");
    expect(p).toContain("build X");
  });
  it("mid-run reply includes the operator question and state", () => {
    const p = buildMidRunReplyPrompt([{ ts: 1, type: "operator_msg", text: "build X" } as any], "1 task active, gate pending", "how is it going?");
    expect(p).toContain("how is it going?");
    expect(p).toContain("gate pending");
  });
});
