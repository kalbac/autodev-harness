import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgents, AGENT_CATALOG, type AgentCatalogEntry } from "./detect-agents.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "adh-detect-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Write a file under `base` and mark it executable (0o755) so the POSIX
 *  `X_OK` resolver check passes on a real Linux CI runner. A no-op-ish on win32. */
function writeExe(name: string, content = "#!/bin/sh\necho 1.2.3\n"): string {
  const p = join(base, name);
  writeFileSync(p, content);
  chmodSync(p, 0o755);
  return p;
}

const codexEntry: AgentCatalogEntry = {
  id: "codex",
  name: "Codex CLI",
  bin: "codex",
  supported: true,
  models: [{ id: "gpt-5.5" }],
  efforts: ["none", "medium", "high"],
};

const claudeEntry: AgentCatalogEntry = {
  id: "claude",
  name: "Claude Code",
  bin: "claude",
  fallbackBins: ["openclaude"],
  supported: true,
  models: [{ id: "sonnet" }],
};

const unsupportedEntry: AgentCatalogEntry = {
  id: "gemini",
  name: "Gemini CLI",
  bin: "gemini",
  supported: false,
};

describe("detectAgents — PATHEXT landmine (win32)", () => {
  // The file is written as `codex.CMD` (matching real Windows' uppercase PATHEXT)
  // so the `bin + ext` candidate resolves on a case-SENSITIVE Linux CI FS too --
  // the simulated win32 resolver must not depend on the host FS casing.
  it("resolves a bin that only exists as a `.CMD` shim -- a bare-name existsSync would miss it", async () => {
    writeExe("codex.CMD", "@echo off\r\necho 1.0.0\r\n");

    const agents = await detectAgents({
      platform: "win32",
      pathext: ".EXE;.CMD",
      pathDirs: [base],
      catalog: [codexEntry],
      probeVersion: async () => null,
    });

    expect(agents).toHaveLength(1);
    expect(agents[0]!.available).toBe(true);
    expect(agents[0]!.path).toMatch(/codex\.cmd$/i);
  });

  it("misses the shim when PATHEXT doesn't include .CMD (proves the landmine is real)", async () => {
    writeExe("codex.CMD", "@echo off\r\necho 1.0.0\r\n");

    const agents = await detectAgents({
      platform: "win32",
      pathext: ".EXE",
      pathDirs: [base],
      catalog: [codexEntry],
      probeVersion: async () => null,
    });

    expect(agents[0]!.available).toBe(false);
    expect(agents[0]!.path).toBeUndefined();
  });
});

describe("detectAgents — POSIX bare name", () => {
  it("resolves an extensionless binary on a POSIX-style PATH", async () => {
    const p = writeExe("claude");

    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [base],
      catalog: [claudeEntry],
      probeVersion: async () => null,
    });

    expect(agents[0]!.available).toBe(true);
    expect(agents[0]!.path).toBe(p);
  });
});

describe("detectAgents — executability guard (existsSync false positives)", () => {
  it("does NOT report a same-named DIRECTORY as installed", async () => {
    mkdirSync(join(base, "codex")); // a directory, not a binary

    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [base],
      catalog: [codexEntry],
      probeVersion: async () => null,
    });

    expect(agents[0]!.available).toBe(false);
    expect(agents[0]!.path).toBeUndefined();
  });

  // POSIX-only: `X_OK` is meaningful on POSIX; on win32 node maps it to R_OK.
  it.skipIf(process.platform === "win32")(
    "does NOT report a non-executable file as installed (POSIX X_OK)",
    async () => {
      const p = join(base, "codex");
      writeFileSync(p, "#!/bin/sh\necho 1.2.3\n");
      chmodSync(p, 0o644); // readable but NOT executable

      const agents = await detectAgents({
        platform: "linux",
        pathDirs: [base],
        catalog: [codexEntry],
        probeVersion: async () => null,
      });

      expect(agents[0]!.available).toBe(false);
    },
  );
});

describe("detectAgents — fallbackBins", () => {
  it("resolves via a fallback bin when the primary bin is absent", async () => {
    const p = writeExe("openclaude");

    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [base],
      catalog: [claudeEntry],
      probeVersion: async () => null,
    });

    expect(agents[0]!.available).toBe(true);
    expect(agents[0]!.path).toBe(p);
  });
});

describe("detectAgents — missing bin", () => {
  it("reports unavailable with path/version omitted when the bin is nowhere on PATH", async () => {
    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [],
      catalog: [claudeEntry],
      probeVersion: async () => null,
    });

    expect(agents[0]!.available).toBe(false);
    expect(agents[0]!.path).toBeUndefined();
    expect(agents[0]!.version).toBeUndefined();
  });
});

describe("detectAgents — version surfaced via injected probeVersion", () => {
  it("surfaces a resolved version string", async () => {
    writeExe("codex");

    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [base],
      catalog: [codexEntry],
      probeVersion: async () => "1.2.3",
    });

    expect(agents[0]!.version).toBe("1.2.3");
  });

  it("omits version when the probe resolves null", async () => {
    writeExe("codex");

    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [base],
      catalog: [codexEntry],
      probeVersion: async () => null,
    });

    expect(agents[0]!.version).toBeUndefined();
  });
});

describe("detectAgents — supported vs unsupported catalog entries", () => {
  it("carries models/efforts through for supported entries, omits them for unsupported ones", async () => {
    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [],
      catalog: [codexEntry, claudeEntry, unsupportedEntry],
      probeVersion: async () => null,
    });

    const codex = agents.find((a) => a.id === "codex")!;
    const claude = agents.find((a) => a.id === "claude")!;
    const gemini = agents.find((a) => a.id === "gemini")!;

    expect(codex.supported).toBe(true);
    expect(codex.models).toEqual([{ id: "gpt-5.5" }]);
    expect(codex.efforts).toEqual(["none", "medium", "high"]);

    expect(claude.supported).toBe(true);
    expect(claude.models).toEqual([{ id: "sonnet" }]);
    expect(claude.efforts).toBeUndefined();

    expect(gemini.supported).toBe(false);
    expect(gemini.models).toBeUndefined();
    expect(gemini.efforts).toBeUndefined();
  });
});

describe("detectAgents — a single bad probe never collapses the batch", () => {
  it("keeps the agent whose probe throws as available:true with version omitted, and returns every other agent too", async () => {
    writeExe("codex");
    writeExe("claude");

    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [base],
      catalog: [codexEntry, claudeEntry],
      probeVersion: async (exePath) => {
        if (exePath.endsWith("codex")) throw new Error("boom: probe crashed");
        return "9.9.9";
      },
    });

    expect(agents).toHaveLength(2);
    const codex = agents.find((a) => a.id === "codex")!;
    const claude = agents.find((a) => a.id === "claude")!;
    expect(codex.available).toBe(true);
    expect(codex.version).toBeUndefined();
    expect(claude.available).toBe(true);
    expect(claude.version).toBe("9.9.9");
  });
});

describe("detectAgents — catalog order preserved", () => {
  it("returns agents in the same order as the injected catalog", async () => {
    const agents = await detectAgents({
      platform: "linux",
      pathDirs: [],
      catalog: [claudeEntry, unsupportedEntry, codexEntry],
      probeVersion: async () => null,
    });

    expect(agents.map((a) => a.id)).toEqual(["claude", "gemini", "codex"]);
  });
});

describe("AGENT_CATALOG (default)", () => {
  it("has exactly two supported ids: claude and codex", () => {
    const supportedIds = AGENT_CATALOG.filter((e) => e.supported).map((e) => e.id);
    expect(supportedIds.sort()).toEqual(["claude", "codex"]);
  });

  it("claude has no efforts; codex has efforts", () => {
    const claude = AGENT_CATALOG.find((e) => e.id === "claude")!;
    const codex = AGENT_CATALOG.find((e) => e.id === "codex")!;
    expect(claude.efforts).toBeUndefined();
    expect(codex.efforts).toBeDefined();
    expect(codex.efforts!.length).toBeGreaterThan(0);
  });

  it("every catalog entry has a plausible installUrl", () => {
    for (const entry of AGENT_CATALOG) {
      expect(entry.installUrl).toMatch(/^https?:\/\//);
    }
  });
});
