import { describe, it, expect } from "vitest";
import { stripFencedJson, StreamingFenceStripper } from "./strip-fenced-json.js";

describe("stripFencedJson (batch)", () => {
  it("removes a ```json fenced block, keeps surrounding prose", () => {
    const input = "Here is the plan:\n```json\n[{\"id\":\"t1\"}]\n```\nLaunch when ready.";
    expect(stripFencedJson(input)).toBe("Here is the plan:\n\nLaunch when ready.");
  });
  it("leaves prose without a json fence untouched", () => {
    expect(stripFencedJson("Just a question for you?")).toBe("Just a question for you?");
  });
  it("only strips ```json, not other fenced code", () => {
    const input = "```ts\nconst x = 1;\n```";
    expect(stripFencedJson(input)).toBe(input);
  });
  it("drops an unterminated trailing ```json fence (matches streaming)", () => {
    expect(stripFencedJson("x ```json\n{unclosed")).toBe("x ");
  });
});

describe("StreamingFenceStripper agrees with batch", () => {
  const cases = [
    "Here is the plan:\n```json\n[{\"id\":\"t1\"}]\n```\nGo.",
    "no fence here",
    "```json\n[]\n``` trailing",
    "pre ```json\n{a}\n``` mid ```json\n{b}\n``` post",
    "x ```json\n{unclosed",
  ];
  for (const [i, text] of cases.entries()) {
    it(`case ${i}: char-by-char stream equals batch`, () => {
      const s = new StreamingFenceStripper();
      let out = "";
      for (const ch of text) out += s.push(ch);
      out += s.end();
      expect(out).toBe(stripFencedJson(text));
    });
  }
});
