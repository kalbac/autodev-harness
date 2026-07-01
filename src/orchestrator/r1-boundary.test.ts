import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mechanical restatement of adr/003's R1 guarantee: "the orchestrator
 * physically cannot talk past the gate." This is a code-level trip-wire, not
 * a design review — it reads the raw source text of every non-test file
 * under src/orchestrator/ and asserts none of them import an enforcement
 * module, or call a known commit/merge/gate entrypoint. If a future change
 * needs one of these, that is exactly the moment this test should fail and
 * force an explicit design decision instead of a silent regression.
 *
 * This is best-effort defense-in-depth, not a hermetic sandbox: it only
 * catches relative-path imports (`../gate/...`) whose specifier textually
 * contains a forbidden directory segment. The project uses NodeNext-style
 * relative `.js` imports throughout (no path aliases / bare-specifier
 * re-exports of these modules), so a relative-path scan is a reasonably
 * complete net for this codebase — but it is not proof against, e.g., a
 * re-export laundered through an intermediate file outside src/orchestrator/.
 */

const ORCHESTRATOR_DIR = dirname(fileURLToPath(import.meta.url));

// Ban the ENTIRE enforcement directories, not just today's known adapters —
// the orchestrator substrate legitimately needs none of gate/, worker/,
// critic/, or worktree/, so any import reaching into them (static or
// dynamic) is forbidden regardless of which file inside is targeted.
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+["'][^"']*\.\.\/(gate|worker|critic|worktree)\//,
  /import\s*\(\s*["'][^"']*\.\.\/(gate|worker|critic|worktree)\//,
];

// Known commit/merge/gate call sites (see gate/gate.ts, worktree/worktree.ts)
// an orchestrator module must never invoke directly.
const FORBIDDEN_CALL_PATTERNS: RegExp[] = [
  /\bmergeAfterGate\s*\(/,
  /\brunGate\s*\(/,
  /\bevaluateGate\s*\(/,
  /git\s+commit\b/,
  /\.commit\s*\(/,
];

function orchestratorSourceFiles(): string[] {
  return readdirSync(ORCHESTRATOR_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

describe("R1 boundary — src/orchestrator/ cannot import or call enforcement modules", () => {
  const files = orchestratorSourceFiles();

  it("found at least one orchestrator source file to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: no forbidden import`, () => {
      const text = readFileSync(join(ORCHESTRATOR_DIR, file), "utf8");
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        const match = text.match(pattern);
        expect(match, `${file} imports a forbidden enforcement module: ${match?.[0]}`).toBeNull();
      }
    });

    it(`${file}: no forbidden commit/gate call`, () => {
      const text = readFileSync(join(ORCHESTRATOR_DIR, file), "utf8");
      for (const pattern of FORBIDDEN_CALL_PATTERNS) {
        const match = text.match(pattern);
        expect(match, `${file} calls a forbidden commit/gate entrypoint: ${match?.[0]}`).toBeNull();
      }
    });
  }
});
