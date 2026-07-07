import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGit } from "./detect-git.js";

describe("detectGit", () => {
  it("reports not installed when git is absent from the injected PATH", async () => {
    const empty = mkdtempSync(join(tmpdir(), "adh-nogit-"));
    try {
      const r = await detectGit({ platform: "linux", pathDirs: [empty], probeVersion: async () => null });
      expect(r).toEqual({ installed: false });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("reports installed + version when a git executable is on the injected PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "adh-git-bin-"));
    try {
      const exe = join(bin, "git");
      writeFileSync(exe, "#!/bin/sh\necho 'git version 2.99.0'\n");
      chmodSync(exe, 0o755);
      const probeCalls: { exePath: string; args: string[] }[] = [];
      const r = await detectGit({
        platform: "linux",
        pathDirs: [bin],
        probeVersion: async (exePath, args) => {
          probeCalls.push({ exePath, args });
          return "git version 2.99.0";
        },
      });
      expect(r).toEqual({ installed: true, version: "git version 2.99.0" });
      // The default probe must actually be wired up to the resolved binary —
      // asserting only the injected version string (as before) also passes if
      // `probeVersion` were never called with the right executable/args.
      expect(probeCalls).toEqual([{ exePath: exe, args: ["--version"] }]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
