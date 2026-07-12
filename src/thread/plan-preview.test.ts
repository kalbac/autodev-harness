import { describe, it, expect } from "vitest";
import { toPlanPreview } from "./plan-preview.js";

describe("toPlanPreview", () => {
  it("projects TaskSpec to {id,title,type,file_set} and drops other fields", () => {
    const specs = [
      { id: "t1", title: "Build", type: "feature", file_set: ["a.ts", "b.ts"], depends_on: ["t0"], model: "sonnet" },
    ] as any;
    expect(toPlanPreview(specs)).toEqual([{ id: "t1", title: "Build", type: "feature", file_set: ["a.ts", "b.ts"] }]);
  });

  it("returns [] for undefined", () => {
    expect(toPlanPreview(undefined)).toEqual([]);
  });
});
