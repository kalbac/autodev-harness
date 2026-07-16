import { describe, it, expect } from "vitest";
import { isRetryable } from "./overnight-supervisor.js";
import type { EscalationType } from "../escalate/escalate.js";

describe("isRetryable (reason-routing table)", () => {
  const retryable: EscalationType[] = ["disagreement", "uncertain", "poison"];
  const park: EscalationType[] = ["constitution", "needs-guard", "blocked", "dirty-file", "drift"];

  for (const t of retryable) it(`routes ${t} -> auto-rework`, () => expect(isRetryable(t)).toBe(true));
  for (const t of park) it(`routes ${t} -> park`, () => expect(isRetryable(t)).toBe(false));
});
