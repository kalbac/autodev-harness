import { describe, it, expect } from "vitest";
import { globMatch } from "./glob.js";

describe("globMatch", () => {
  it("* matches within a segment, not across slashes", () => {
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/sub/a.ts")).toBe(false);
  });
  it("** matches across slashes", () => {
    expect(globMatch("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/sub/deep/a.ts")).toBe(true);
  });
  it("normalizes backslashes to forward slashes", () => {
    expect(globMatch("src/*.ts", "src\\a.ts")).toBe(true);
  });
  it("matches a bare filename glob anywhere via **", () => {
    expect(globMatch("**/*-policy.md", "docs/x-policy.md")).toBe(true);
  });
});
