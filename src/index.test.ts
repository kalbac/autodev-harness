import { describe, it, expect } from "vitest";
import { parseReportArgs } from "./index.js";

describe("parseReportArgs -- report morning", () => {
  it("parses a bare 'morning' with no --since", () => {
    expect(parseReportArgs(["morning"])).toEqual({ mode: "report-morning" });
  });

  it("parses '--since <ISO>' as a separate argument", () => {
    expect(parseReportArgs(["morning", "--since", "2026-07-23T00:00:00Z"])).toEqual({
      mode: "report-morning",
      since: "2026-07-23T00:00:00Z",
    });
  });

  it("parses '--since=<ISO>' in the single-token form", () => {
    expect(parseReportArgs(["morning", "--since=2026-07-23T00:00:00Z"])).toEqual({
      mode: "report-morning",
      since: "2026-07-23T00:00:00Z",
    });
  });

  it("throws loud on a missing --since value rather than silently dropping it", () => {
    expect(() => parseReportArgs(["morning", "--since"])).toThrow(/--since: missing value/);
  });

  it("throws loud on an unexpected extra argument", () => {
    expect(() => parseReportArgs(["morning", "--bogus"])).toThrow(/unexpected argument/);
  });

  it("throws loud on a --since that is not a valid ISO timestamp", () => {
    expect(() => parseReportArgs(["morning", "--since", "not-a-date"])).toThrow(/must be an ISO timestamp/);
  });

  it("accepts a --since with a timezone offset", () => {
    expect(parseReportArgs(["morning", "--since", "2026-07-23T00:00:00+03:00"])).toEqual({
      mode: "report-morning",
      since: "2026-07-23T00:00:00+03:00",
    });
  });
});
