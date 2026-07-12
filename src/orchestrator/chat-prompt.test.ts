import { describe, it, expect } from "vitest";
import { buildChatOpeningPrompt } from "./chat-prompt.js";
import { LAUNCH_MARKER } from "../thread/launch-marker.js";
import type { ReadSnapshot } from "./adapter.js";

const snapshot = { existingIds: [] } as unknown as ReadSnapshot;

describe("buildChatOpeningPrompt", () => {
  it("embeds the operator intent verbatim", () => {
    const p = buildChatOpeningPrompt("Add a CONTRIBUTING guide", snapshot);
    expect(p).toContain("Add a CONTRIBUTING guide");
  });

  it("teaches the launch-by-word marker contract (so the model can emit it)", () => {
    // Found live (s40): without this the model never emits the marker and
    // launch-by-word can never fire despite the backend detecting it.
    const p = buildChatOpeningPrompt("do a thing", snapshot);
    expect(p).toContain(LAUNCH_MARKER);
    expect(p.toLowerCase()).toContain("launch");
    // only after a plan + only on an explicit request
    expect(p).toMatch(/only after a plan/i);
  });

  it("still asks for the fenced json plan preview", () => {
    const p = buildChatOpeningPrompt("do a thing", snapshot);
    expect(p).toContain("```json");
  });
});
