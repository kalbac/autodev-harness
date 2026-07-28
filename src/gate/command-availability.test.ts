import { describe, it, expect } from "vitest";
import {
  classifyCommand,
  inspectCommand,
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

/** The manager IS installed. Explicit in every script-ref test, because since the s61
 *  review round a script ref asks BOTH questions: a declared script is still unrunnable
 *  when its package manager is missing. */
const managerInstalled: Partial<CommandProbe> = {
  async programExists() {
    return true;
  },
};

describe("classifyCommand — script refs", () => {
  it("is `available` when package.json declares the script and the manager is installed", async () => {
    const probe = makeProbe({ ...scriptsAre("lint", "build"), ...managerInstalled });
    expect(await classifyCommand("pnpm run lint", probe)).toBe("available");
  });

  // Review gate, s61: a declared script proves nothing about the MANAGER. `pnpm run lint`
  // with a real `lint` script is still unrunnable on a machine with no pnpm, and answering
  // `available` sends it to a spawn failure this module exists to name.
  it("is `unavailable` when the manager itself is not installed, even with the script declared", async () => {
    const probe = makeProbe({
      ...scriptsAre("lint"),
      async programExists() {
        return false;
      },
    });
    expect(await classifyCommand("pnpm run lint", probe)).toBe("unavailable");
    const { unavailable } = await inspectCommand("pnpm run lint", probe);
    expect(unavailable?.reason).toBe("program-not-on-path");
    expect(unavailable?.detail).toContain("pnpm");
  });

  it("is `unknown` when the script is declared but the manager probe could not answer", async () => {
    // Neither "yes" nor "no": the command runs exactly as it would have before this
    // pre-flight existed, which is what `unknown` means everywhere in this module.
    const probe = makeProbe(scriptsAre("lint"));
    expect(await classifyCommand("pnpm run lint", probe)).toBe("unknown");
  });

  // `adr/009`: the operator's declaration IS the oracle. Without this carve-out the
  // classifier would need a complete model of every manager's subcommands to avoid
  // refusing a command that runs perfectly well (`pnpm config get registry` reads as a
  // missing `config` script otherwise).
  it("never refuses a command the OPERATOR declared, whatever the probes say", async () => {
    const probe = makeProbe({
      ...scriptsAre(),
      async programExists() {
        return false;
      },
      isOperatorDeclared: (cmd) => cmd === "pnpm config get registry",
    });
    expect(await classifyCommand("pnpm config get registry", probe)).toBe("unknown");
    // ...and an UNdeclared command in the same project is still refused.
    expect(await classifyCommand("pnpm nope", probe)).toBe("unavailable");
  });

  it("is `unavailable` when the project declares no such script", async () => {
    // The s60 incident, exactly: the composer invented `lint:php:changes`.
    const probe = makeProbe({ ...scriptsAre("lint", "build"), ...managerInstalled });
    expect(await classifyCommand("pnpm lint:php:changes", probe)).toBe("unavailable");
  });

  it("is `unavailable` against an EMPTY script set (a project that declares none)", async () => {
    const probe = makeProbe({ ...scriptsAre(), ...managerInstalled });
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

  it("asks the PATH probe about the MANAGER only -- never about the script name", async () => {
    const seen: string[] = [];
    const probe = makeProbe({
      ...scriptsAre("lint"),
      async programExists(p) {
        seen.push(p);
        return true;
      },
    });
    expect(await classifyCommand("pnpm run lint", probe)).toBe("available");
    expect(seen).toEqual(["pnpm"]);
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

// The REASON travels with the verdict rather than being re-derived from the command
// string by whoever reports it: the same string is unavailable for two different causes,
// and only the code that asked the probes knows which
// (`[critic/validated-one-string-used-another]`, review gate s61).
describe("inspectCommand -- the cause travels with the verdict", () => {
  it("names the command and says the SCRIPT is not declared", async () => {
    const { availability, unavailable } = await inspectCommand(
      "pnpm lint:php:changes",
      makeProbe({ ...scriptsAre("lint"), ...managerInstalled }),
    );
    expect(availability).toBe("unavailable");
    expect(unavailable?.reason).toBe("script-not-declared");
    expect(unavailable?.detail).toContain("pnpm lint:php:changes");
    expect(unavailable?.detail).toContain("lint:php:changes");
    expect(unavailable?.detail).toMatch(/package\.json/);
  });

  it("names the command and says the PROGRAM is not on PATH", async () => {
    const { availability, unavailable } = await inspectCommand(
      "phpstan analyse",
      makeProbe({
        async programExists() {
          return false;
        },
      }),
    );
    expect(availability).toBe("unavailable");
    expect(unavailable?.reason).toBe("program-not-on-path");
    expect(unavailable?.detail).toContain("phpstan analyse");
    expect(unavailable?.detail).toMatch(/PATH/);
  });

  it("carries NO cause when the command is not unavailable", async () => {
    const report = await inspectCommand("php -l x.php", makeProbe({ ...managerInstalled }));
    expect(report.availability).toBe("available");
    expect(report.unavailable).toBeUndefined();
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
