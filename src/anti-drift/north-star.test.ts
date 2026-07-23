import { describe, it, expect } from "vitest";
import { isNorthStarSilent, NORTH_STAR_UNFILLED_SENTINEL } from "./north-star.js";
import { GOAL_STUB } from "../registry/scaffold.js";

describe("isNorthStarSilent", () => {
  it("treats an absent north-star (null) as silent", () => {
    expect(isNorthStarSilent(null)).toBe(true);
  });

  it("treats an empty or whitespace-only north-star as silent", () => {
    expect(isNorthStarSilent("")).toBe(true);
    expect(isNorthStarSilent("   \n\t  \r\n ")).toBe(true);
  });

  it("treats a north-star still carrying the unfilled sentinel as silent", () => {
    const text = ["# GOAL", "", "## What it is", NORTH_STAR_UNFILLED_SENTINEL, ""].join("\n");
    expect(isNorthStarSilent(text)).toBe(true);
  });

  it("treats real, sentinel-free content as NOT silent", () => {
    const text = [
      "# GOAL",
      "## What it is",
      "A WooCommerce shipping plugin for a Russian courier.",
      "## What it must never do",
      "Never change the checkout total silently.",
    ].join("\n");
    expect(isNorthStarSilent(text)).toBe(false);
  });

  it("is silent if ANY section still carries the sentinel, even when others are filled", () => {
    const text = [
      "# GOAL",
      "## What it is",
      "A real, filled-in description.",
      "## What it must never do",
      NORTH_STAR_UNFILLED_SENTINEL,
    ].join("\n");
    expect(isNorthStarSilent(text)).toBe(true);
  });

  it("classifies the actual scaffolded GOAL_STUB as silent (pins the sentinel contract)", () => {
    // If scaffold.ts and north-star.ts ever drift on the sentinel string, a
    // freshly-scaffolded, never-edited GOAL.md would read as PRESENT and an
    // unattended run would proceed against an unwritten intent -- the exact
    // fail-open this guard exists to prevent. This test fails loudly if they do.
    expect(isNorthStarSilent(GOAL_STUB)).toBe(true);
  });
});
