import { describe, it, expect } from "vitest";
import {
  classifyCommand,
  describeUnavailableCommand,
  CommandUnavailableError,
  type CommandProbe,
} from "./command-availability.js";

/** A probe with explicit, per-test answers. Both seams default to "could not determine". */
function makeProbe(over: Partial<CommandProbe> = {}): CommandProbe {
  return {
    async packageScripts() {
      return null;
    },
    async programExists() {
      return null;
    },
    ...over,
  };
}

const scriptsAre = (...names: string[]): Partial<CommandProbe> => ({
  async packageScripts() {
    return new Set(names);
  },
});

describe("classifyCommand — script refs", () => {
  it("is `available` when package.json declares the script", async () => {
    const probe = makeProbe(scriptsAre("lint", "build"));
    expect(await classifyCommand("pnpm run lint", probe)).toBe("available");
  });

  it("is `unavailable` when the project declares no such script", async () => {
    // The s60 incident, exactly: the composer invented `lint:php:changes`.
    const probe = makeProbe(scriptsAre("lint", "build"));
    expect(await classifyCommand("pnpm lint:php:changes", probe)).toBe("unavailable");
  });

  it("is `unavailable` against an EMPTY script set (a project that declares none)", async () => {
    const probe = makeProbe(scriptsAre());
    expect(await classifyCommand("npm run build", probe)).toBe("unavailable");
  });

  it("is `unknown` -- NOT `unavailable` -- when the script set could not be determined", async () => {
    // `[logic/ambiguous-false]`: "I could not tell" must never collapse into "no".
    // An unreadable package.json must not manufacture a refusal.
    const probe = makeProbe({
      async packageScripts() {
        return null;
      },
    });
    expect(await classifyCommand("pnpm run lint", probe)).toBe("unknown");
  });

  it("never consults the PATH probe for a script ref", async () => {
    let programCalls = 0;
    const probe = makeProbe({
      ...scriptsAre("lint"),
      async programExists() {
        programCalls++;
        return false;
      },
    });
    expect(await classifyCommand("pnpm run lint", probe)).toBe("available");
    expect(programCalls).toBe(0);
  });
});

describe("classifyCommand — program refs", () => {
  it("is `available` when the program resolves", async () => {
    const probe = makeProbe({
      async programExists() {
        return true;
      },
    });
    expect(await classifyCommand("php -l src/x.php", probe)).toBe("available");
  });

  it("is `unavailable` when the program positively does not resolve", async () => {
    const probe = makeProbe({
      async programExists() {
        return false;
      },
    });
    expect(await classifyCommand("phpstan analyse", probe)).toBe("unavailable");
  });

  it("is `unknown` -- NOT `unavailable` -- when the PATH probe could not determine", async () => {
    const probe = makeProbe({
      async programExists() {
        return null;
      },
    });
    expect(await classifyCommand("phpstan analyse", probe)).toBe("unknown");
  });

  it("passes the RAW program token to the probe (not a normalized basename)", async () => {
    const seen: string[] = [];
    const probe = makeProbe({
      async programExists(p) {
        seen.push(p);
        return true;
      },
    });
    await classifyCommand("./scripts/check.sh --fast", probe);
    expect(seen).toEqual(["./scripts/check.sh"]);
  });

  it("classifies an npm SUBCOMMAND as a program, not a missing script", async () => {
    // `npm ci` must be probed on PATH as `npm`, never looked up as a script named "ci".
    const seen: string[] = [];
    const probe = makeProbe({
      ...scriptsAre("lint"),
      async programExists(p) {
        seen.push(p);
        return true;
      },
    });
    expect(await classifyCommand("npm ci", probe)).toBe("available");
    expect(seen).toEqual(["npm"]);
  });
});

describe("classifyCommand — unparseable", () => {
  it.each(["", "   "])("is `unknown` for %j", async (cmd) => {
    expect(await classifyCommand(cmd, makeProbe())).toBe("unknown");
  });
});

describe("describeUnavailableCommand", () => {
  it("names the command and says the SCRIPT is not declared", () => {
    const { reason, detail } = describeUnavailableCommand("pnpm lint:php:changes");
    expect(reason).toBe("script-not-declared");
    expect(detail).toContain("pnpm lint:php:changes");
    expect(detail).toContain("lint:php:changes");
    expect(detail).toMatch(/package\.json/);
  });

  it("names the command and says the PROGRAM is not on PATH", () => {
    const { reason, detail } = describeUnavailableCommand("phpstan analyse");
    expect(reason).toBe("program-not-on-path");
    expect(detail).toContain("phpstan analyse");
    expect(detail).toMatch(/PATH/);
  });
});

describe("CommandUnavailableError", () => {
  it("mirrors AgentCiUnavailableError's shape (name + reason + detail as the message)", () => {
    const err = new CommandUnavailableError("script-not-declared", "some detail");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CommandUnavailableError");
    expect(err.reason).toBe("script-not-declared");
    expect(err.detail).toBe("some detail");
    expect(err.message).toBe("some detail");
  });
});
