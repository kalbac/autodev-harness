import { describe, it, expect } from "vitest";
import { parseCommandRef, splitCommand, type CommandRef } from "./command-ref.js";

/** Narrow to a script ref (fails the test loudly instead of returning undefined). */
function script(cmd: string): { manager: string; script: string } {
  const ref = parseCommandRef(cmd);
  expect(ref, `expected ${JSON.stringify(cmd)} to parse`).not.toBeNull();
  expect(ref!.kind, `expected ${JSON.stringify(cmd)} to be a script ref`).toBe("script");
  const s = ref as Extract<CommandRef, { kind: "script" }>;
  return { manager: s.manager, script: s.script };
}

/** Narrow to a program ref. */
function program(cmd: string): { program: string; args: string[] } {
  const ref = parseCommandRef(cmd);
  expect(ref, `expected ${JSON.stringify(cmd)} to parse`).not.toBeNull();
  expect(ref!.kind, `expected ${JSON.stringify(cmd)} to be a program ref`).toBe("program");
  const p = ref as Extract<CommandRef, { kind: "program" }>;
  return { program: p.program, args: p.args };
}

describe("splitCommand", () => {
  it("splits on whitespace runs and trims", () => {
    expect(splitCommand("  npm   run   build  ")).toEqual({ c: "npm", a: ["run", "build"] });
  });

  it("throws on an empty command (the pre-existing composition-root contract)", () => {
    expect(() => splitCommand("   ")).toThrow(/empty command/);
  });
});

describe("parseCommandRef — empty / unparseable", () => {
  it("returns null for an empty string", () => {
    expect(parseCommandRef("")).toBeNull();
  });

  it("returns null for a whitespace-only string", () => {
    expect(parseCommandRef("   \t \n ")).toBeNull();
  });
});

describe("parseCommandRef — npm", () => {
  it("reads `npm run <name>` as a script ref", () => {
    expect(script("npm run build")).toEqual({ manager: "npm", script: "build" });
  });

  it("reads `npm run-script <name>` as a script ref", () => {
    expect(script("npm run-script build")).toEqual({ manager: "npm", script: "build" });
  });

  it("reads `npm test` as the `test` script", () => {
    expect(script("npm test")).toEqual({ manager: "npm", script: "test" });
  });

  it("reads `npm start` as the `start` script", () => {
    expect(script("npm start")).toEqual({ manager: "npm", script: "start" });
  });

  it.each(["npm ci", "npm install", "npm exec foo", "npm publish"])(
    "treats the npm SUBCOMMAND in %j as a program, never a script",
    (cmd) => {
      expect(program(cmd).program).toBe("npm");
    },
  );

  it("does NOT treat a bare `npm <other>` as a script ref (npm has no implicit script form)", () => {
    // The exact shape that started this work: `pnpm lint:php:changes` is a script
    // ref, but `npm lint:php:changes` is an unknown npm SUBCOMMAND, not a script.
    expect(program("npm lint:php:changes").program).toBe("npm");
  });

  it("treats `npm run` with no script name as a program (missing name => not a script ref)", () => {
    expect(program("npm run").args).toEqual(["run"]);
  });
});

describe("parseCommandRef — pnpm / yarn / bun", () => {
  it("reads `pnpm run <name>`", () => {
    expect(script("pnpm run lint")).toEqual({ manager: "pnpm", script: "lint" });
  });

  it("reads the bare `pnpm <name>` script form", () => {
    // The s60 incident command: the composer invented this and no such script exists.
    expect(script("pnpm lint:php:changes")).toEqual({ manager: "pnpm", script: "lint:php:changes" });
  });

  it("reads `yarn run <name>` and the bare `yarn <name>` form", () => {
    expect(script("yarn run test")).toEqual({ manager: "yarn", script: "test" });
    expect(script("yarn test")).toEqual({ manager: "yarn", script: "test" });
  });

  it("reads `bun run <name>`", () => {
    expect(script("bun run build")).toEqual({ manager: "bun", script: "build" });
  });

  it("does NOT read a bare `bun <name>` as a script ref (bun requires the explicit `run`)", () => {
    expect(program("bun build").program).toBe("bun");
  });

  it.each([
    "pnpm install",
    "pnpm i",
    "pnpm add zod",
    "pnpm remove zod",
    "pnpm rm zod",
    "pnpm exec tsc",
    "pnpm dlx foo",
    "pnpm up",
    "pnpm update",
    "pnpm init",
    "pnpm why zod",
    "pnpm list",
    "pnpm ls",
    "pnpm link",
    "pnpm unlink",
    "pnpm pack",
    "pnpm publish",
    "pnpm audit",
    "pnpm store prune",
    "pnpm licenses list",
    "pnpm create vite",
    "yarn add zod",
    "yarn x foo",
    "yarn ci",
  ])("treats the built-in subcommand in %j as a program, never a script", (cmd) => {
    const ref = parseCommandRef(cmd);
    expect(ref!.kind).toBe("program");
  });
});

describe("parseCommandRef — manager basename normalization", () => {
  it("matches a `.cmd` shim (the Windows npm-global shape)", () => {
    expect(script("pnpm.cmd run lint")).toEqual({ manager: "pnpm", script: "lint" });
  });

  it("matches an `.exe` suffix", () => {
    expect(script("npm.exe run build")).toEqual({ manager: "npm", script: "build" });
  });

  it("matches case-insensitively (PATHEXT reports .CMD upper-case)", () => {
    expect(script("PNPM.CMD run lint")).toEqual({ manager: "pnpm", script: "lint" });
  });

  it("matches an absolute Windows path to the manager", () => {
    expect(script("C:\\tools\\nodejs\\npm.cmd run build")).toEqual({ manager: "npm", script: "build" });
  });

  it("cannot parse a manager path containing SPACES -- and neither can the runner", () => {
    // Pre-existing, deliberately inherited limitation (gotcha `[conductor/wiring]`):
    // the gate's own `splitCommand` is whitespace-only, so `C:\Program Files\...`
    // is split into `C:\Program` + `Files\...` and the command the gate would spawn
    // is already wrong. Parsing it "correctly" here would describe a command the
    // runner never runs -- the two must agree, so this stays a program ref.
    expect(program("C:\\Program Files\\nodejs\\npm.cmd run build").program).toBe("C:\\Program");
  });

  it("matches a POSIX path to the manager", () => {
    expect(script("/usr/local/bin/pnpm run lint")).toEqual({ manager: "pnpm", script: "lint" });
  });

  it("keeps the RAW first token as `program` for a non-manager path (what a PATH probe must resolve)", () => {
    expect(program("./scripts/check.sh --fast")).toEqual({
      program: "./scripts/check.sh",
      args: ["--fast"],
    });
  });
});

describe("parseCommandRef — conservative refusals", () => {
  it("refuses a `-`-prefixed token where a subcommand/script name is expected", () => {
    expect(program("npm --prefix ./sub run build").program).toBe("npm");
    expect(program("pnpm --filter web lint").program).toBe("pnpm");
  });

  it("refuses a `-`-prefixed token immediately after `run`", () => {
    expect(program("npm run --silent build").program).toBe("npm");
  });

  it("still reads the script when the FLAGS come after the script name", () => {
    // "leading" `-` tokens are the ambiguous ones; tokens after the resolved
    // script name are the script's own args and cannot change which script is named.
    expect(script("npm run test -- --coverage")).toEqual({ manager: "npm", script: "test" });
  });

  it("treats a bare manager with no arguments as a program", () => {
    expect(program("pnpm").args).toEqual([]);
  });

  it("treats a non-manager program as a program ref with its args", () => {
    expect(program("php -l src/x.php")).toEqual({ program: "php", args: ["-l", "src/x.php"] });
  });

  it("does not mistake a program whose name merely CONTAINS a manager name", () => {
    expect(program("npmx run build").program).toBe("npmx");
    expect(program("my-npm run build").program).toBe("my-npm");
  });
});
