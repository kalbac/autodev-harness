import { describe, it, expect } from "vitest";
import { extractJsonArray } from "./json-array-extract.js";

describe("extractJsonArray", () => {
  it("parses a bare top-level array", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it("skips a stray bracket in leading prose and finds the real array", () => {
    const text = 'Here are tasks [draft]\n[{"a":1},{"b":2}]';
    expect(extractJsonArray(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("ignores brackets inside a JSON string literal when balancing", () => {
    const text = '[{"title":"fix [x] bug"}]';
    expect(extractJsonArray(text)).toEqual([{ title: "fix [x] bug" }]);
  });

  it("returns null when nothing balances", () => {
    expect(extractJsonArray("no array here, just [ unbalanced")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractJsonArray("")).toBeNull();
  });
});
