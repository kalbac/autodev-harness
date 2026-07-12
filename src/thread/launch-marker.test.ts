import { describe, it, expect } from "vitest";
import { LAUNCH_MARKER, containsLaunchMarker, stripLaunchMarker } from "./launch-marker.js";

describe("launch marker", () => {
  it("detects the marker anywhere in the text", () => {
    expect(containsLaunchMarker(`Sure, launching now. ${LAUNCH_MARKER}`)).toBe(true);
    expect(containsLaunchMarker("let me clarify one thing first")).toBe(false);
  });
  it("strips the marker (and a lone trailing line) from prose", () => {
    expect(stripLaunchMarker(`Launching now.\n${LAUNCH_MARKER}`)).toBe("Launching now.");
  });
});
