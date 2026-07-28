import { describe, it, expect } from "vitest";
import {
  filterSuccessCommands,
  normalizeCommandText,
  type CommandDeclaration,
} from "./success-command-policy.js";

function decl(over: Partial<CommandDeclaration> = {}): CommandDeclaration {
  return { scripts: [], configured: [], scriptsKnown: true, ...over };
}

describe("normalizeCommandText", () => {
  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeCommandText("  npm   run    lint  ")).toBe("npm run lint");
  });
});

describe("filterSuccessCommands — allow rules", () => {
  it("keeps a command whose script is declared in package.json", () => {
    const r = filterSuccessCommands(["pnpm run lint"], decl({ scripts: ["lint"] }));
    expect(r.kept).toEqual(["pnpm run lint"]);
    expect(r.dropped).toEqual([]);
  });

  it("keeps the bare `pnpm <script>` form when the script is declared", () => {
    const r = filterSuccessCommands(["pnpm lint"], decl({ scripts: ["lint"] }));
    expect(r.kept).toEqual(["pnpm lint"]);
  });

  it("keeps a command the OPERATOR declared verbatim, even though it is no script", () => {
    const r = filterSuccessCommands(["php -l src/x.php"], decl({ configured: ["php -l src/x.php"] }));
    expect(r.kept).toEqual(["php -l src/x.php"]);
    expect(r.dropped).toEqual([]);
  });

  it("matches an operator-declared command through NORMALIZED text on both sides", () => {
    // The check and the use must share one normalization
    // (`docs/gotchas/validated-one-string-used-another.md`).
    const r = filterSuccessCommands(["  php   -l  src/x.php "], decl({ configured: [" php -l   src/x.php" ] }));
    expect(r.kept).toEqual(["  php   -l  src/x.php "]);
  });

  it("keeps the ORIGINAL command text, not the normalized form", () => {
    const r = filterSuccessCommands(["pnpm   run   lint"], decl({ scripts: ["lint"] }));
    expect(r.kept).toEqual(["pnpm   run   lint"]);
  });
});

describe("filterSuccessCommands — deny by default", () => {
  it("DROPS the hallucinated command from the s60 incident", () => {
    const r = filterSuccessCommands(["pnpm lint:php:changes"], decl({ scripts: ["lint", "build"] }));
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(["pnpm lint:php:changes"]);
    expect(r.filterSkipped).toBe(false);
  });

  it("DROPS an arbitrary program the operator never declared", () => {
    const r = filterSuccessCommands(["phpstan analyse"], decl({ scripts: ["lint"] }));
    expect(r.dropped).toEqual(["phpstan analyse"]);
  });

  it("DROPS a script-shaped command whose script is not declared, even for a declared MANAGER", () => {
    const r = filterSuccessCommands(["npm run nope"], decl({ scripts: ["lint"], configured: ["npm run lint"] }));
    expect(r.dropped).toEqual(["npm run nope"]);
  });

  it("keeps and drops independently within one spec", () => {
    const r = filterSuccessCommands(
      ["pnpm run lint", "pnpm lint:php:changes", "php -l x.php"],
      decl({ scripts: ["lint"], configured: ["php -l x.php"] }),
    );
    expect(r.kept).toEqual(["pnpm run lint", "php -l x.php"]);
    expect(r.dropped).toEqual(["pnpm lint:php:changes"]);
  });

  it("drops a blank command (it names nothing)", () => {
    const r = filterSuccessCommands(["   "], decl({ scripts: ["lint"] }));
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(["   "]);
  });

  it("never throws or rejects the batch -- dropping is the whole point", () => {
    const r = filterSuccessCommands(["a", "b", "c"], decl());
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(["a", "b", "c"]);
  });
});

describe("filterSuccessCommands — fail-open when the declaration is unknown", () => {
  it("KEEPS everything and reports the filter could not run when scriptsKnown is false", () => {
    // The ONE exception, and it is loud: half (b) -- the gate's own availability
    // pre-flight -- is the backstop, so silently dropping every command here would
    // remove real checks on the strength of an unreadable package.json.
    const r = filterSuccessCommands(["pnpm lint:php:changes", "phpstan analyse"], decl({ scriptsKnown: false }));
    expect(r.kept).toEqual(["pnpm lint:php:changes", "phpstan analyse"]);
    expect(r.dropped).toEqual([]);
    expect(r.filterSkipped).toBe(true);
  });

  it("still reports filterSkipped when there were no commands at all", () => {
    const r = filterSuccessCommands([], decl({ scriptsKnown: false }));
    expect(r.filterSkipped).toBe(true);
  });

  it("does NOT report filterSkipped on the normal path", () => {
    expect(filterSuccessCommands([], decl()).filterSkipped).toBe(false);
  });
});
