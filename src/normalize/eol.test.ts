import { describe, it, expect } from "vitest";
import { parseCheckAttr, normalizeWorktreeEol, type GitAttr, type NormalizeEolDeps } from "./eol.js";

const NUL = "\0";
function zRecords(...triples: Array<[string, string, string]>): string {
  return triples.map(([p, a, v]) => `${p}${NUL}${a}${NUL}${v}${NUL}`).join("");
}

describe("parseCheckAttr", () => {
  it("groups text+eol per path from -z output", () => {
    const stdout = zRecords(
      ["a.php", "text", "set"],
      ["a.php", "eol", "lf"],
      ["b.png", "text", "unset"],
      ["b.png", "eol", "unspecified"],
    );
    const m = parseCheckAttr(stdout);
    expect(m.get("a.php")).toEqual({ text: "set", eol: "lf" });
    expect(m.get("b.png")).toEqual({ text: "unset", eol: "unspecified" });
  });

  it("maps git's 'unspecified' sentinel and leaves a missing attr unspecified", () => {
    const stdout = zRecords(["c.php", "text", "unspecified"]);
    const m = parseCheckAttr(stdout);
    expect(m.get("c.php")).toEqual({ text: "unspecified", eol: "unspecified" });
  });
});

describe("normalizeWorktreeEol", () => {
  function makeDeps(
    attrs: Record<string, GitAttr>,
    files: Record<string, string>,
  ): { deps: NormalizeEolDeps; writes: Record<string, string>; logs: string[] } {
    const writes: Record<string, string> = {};
    const logs: string[] = [];
    const deps: NormalizeEolDeps = {
      checkAttr: async (_wt, relPaths) => {
        const m = new Map<string, GitAttr>();
        for (const p of relPaths) m.set(p, attrs[p] ?? { text: "unspecified", eol: "unspecified" });
        return m;
      },
      readFile: async (abs) => {
        const rel = abs.split(/[\\/]/).pop()!;
        return Buffer.from(files[rel] ?? "", "latin1");
      },
      writeFile: async (abs, data) => {
        const rel = abs.split(/[\\/]/).pop()!;
        writes[rel] = data.toString("latin1");
      },
      log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
    };
    return { deps, writes, logs };
  }

  it("rewrites CRLF to LF for an undeclared text file (default LF)", async () => {
    const { deps, writes } = makeDeps(
      { "a.php": { text: "unspecified", eol: "unspecified" } },
      { "a.php": "<?php\r\n$x = 1;\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["a.php"]);
    expect(r.normalized).toEqual(["a.php"]);
    expect(writes["a.php"]).toBe("<?php\n$x = 1;\n");
  });

  it("leaves an eol=crlf declared file untouched", async () => {
    const { deps, writes } = makeDeps(
      { "win.txt": { text: "set", eol: "crlf" } },
      { "win.txt": "a\r\nb\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["win.txt"]);
    expect(r.normalized).toEqual([]);
    expect(writes["win.txt"]).toBeUndefined();
  });

  it("leaves a declared-binary (-text) file untouched", async () => {
    const { deps, writes } = makeDeps(
      { "logo.bin": { text: "unset", eol: "unspecified" } },
      { "logo.bin": "\x00\x01\r\n\x02" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["logo.bin"]);
    expect(r.normalized).toEqual([]);
    expect(writes["logo.bin"]).toBeUndefined();
  });

  it("skips an undeclared file whose bytes contain a NUL (binary heuristic)", async () => {
    const { deps, writes } = makeDeps(
      { "blob.dat": { text: "unspecified", eol: "unspecified" } },
      { "blob.dat": "PK\x03\x04\x00\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["blob.dat"]);
    expect(r.normalized).toEqual([]);
    expect(r.skippedBinary).toEqual(["blob.dat"]);
    expect(writes["blob.dat"]).toBeUndefined();
  });

  it("normalizes an explicitly eol=lf file even if it contains a NUL (declaration overrides the guard)", async () => {
    const { deps, writes } = makeDeps(
      { "weird.php": { text: "set", eol: "lf" } },
      { "weird.php": "a\r\n\x00b\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["weird.php"]);
    expect(r.normalized).toEqual(["weird.php"]);
    expect(writes["weird.php"]).toBe("a\n\x00b\n");
  });

  it("does not rewrite an already-LF file (no needless write)", async () => {
    const { deps, writes } = makeDeps(
      { "clean.php": { text: "unspecified", eol: "unspecified" } },
      { "clean.php": "<?php\n$x = 1;\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["clean.php"]);
    expect(r.normalized).toEqual([]);
    expect(writes["clean.php"]).toBeUndefined();
  });

  it("processes a mixed batch: normalizes the text file, skips the binary, leaves crlf-declared", async () => {
    const { deps, writes } = makeDeps(
      {
        "a.php": { text: "unspecified", eol: "unspecified" },
        "b.bin": { text: "unset", eol: "unspecified" },
        "c.txt": { text: "set", eol: "crlf" },
      },
      { "a.php": "x\r\n", "b.bin": "\x00\r\n", "c.txt": "y\r\n" },
    );
    const r = await normalizeWorktreeEol(deps, "/wt", ["a.php", "b.bin", "c.txt"]);
    expect(r.normalized).toEqual(["a.php"]);
    expect(writes["a.php"]).toBe("x\n");
    expect(writes["b.bin"]).toBeUndefined();
    expect(writes["c.txt"]).toBeUndefined();
  });

  it("fails safe: a checkAttr rejection normalizes nothing and logs a WARN", async () => {
    const logs: string[] = [];
    const deps: NormalizeEolDeps = {
      checkAttr: async () => {
        throw new Error("git boom");
      },
      readFile: async () => Buffer.from(""),
      writeFile: async () => {
        throw new Error("should not write");
      },
      log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
    };
    const r = await normalizeWorktreeEol(deps, "/wt", ["a.php"]);
    expect(r.normalized).toEqual([]);
    expect(logs.some((l) => l.startsWith("WARN"))).toBe(true);
  });

  it("continues past a per-file read failure (partial normalization is safe)", async () => {
    const writes: Record<string, string> = {};
    const logs: string[] = [];
    const deps: NormalizeEolDeps = {
      checkAttr: async (_wt, relPaths) => {
        const m = new Map<string, GitAttr>();
        for (const p of relPaths) m.set(p, { text: "unspecified", eol: "unspecified" });
        return m;
      },
      readFile: async (abs) => {
        if (abs.endsWith("bad.php")) throw new Error("EIO");
        return Buffer.from("z\r\n", "latin1");
      },
      writeFile: async (abs, data) => {
        writes[abs.split(/[\\/]/).pop()!] = data.toString("latin1");
      },
      log: (lvl, msg) => logs.push(`${lvl} ${msg}`),
    };
    const r = await normalizeWorktreeEol(deps, "/wt", ["bad.php", "ok.php"]);
    expect(r.normalized).toEqual(["ok.php"]);
    expect(writes["ok.php"]).toBe("z\n");
    expect(logs.some((l) => l.startsWith("WARN"))).toBe(true);
  });
});
