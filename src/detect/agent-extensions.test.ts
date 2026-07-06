import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  extractExtensions,
  probeAgentExtensions,
  makeStreamingSpawnInit,
  MAX_REMAINDER_BYTES,
  type SpawnInit,
  type SpawnFn,
} from "./agent-extensions.js";

/** A realistic `system/init` event body (the fields the probe reads). */
const REALISTIC_INIT = {
  type: "system",
  subtype: "init",
  model: "claude-haiku-4",
  cwd: "/wherever/claude/reports",
  mcp_servers: [
    { name: "supermemory", status: "connected" },
    { name: "serena", status: "failed" },
  ],
  skills: ["deep-research", "code-review"],
  slash_commands: ["review", "commit"],
  agents: ["Explore", "general-purpose"],
};

describe("extractExtensions", () => {
  it("reads a realistic init into the AgentExtensions shape (cwd echoed, not trusted from init)", () => {
    const ext = extractExtensions(REALISTIC_INIT, "/the/probe/cwd");
    expect(ext).toEqual({
      model: "claude-haiku-4",
      cwd: "/the/probe/cwd", // echoed from the arg, NOT init.cwd
      mcp: [
        { name: "supermemory", status: "connected" },
        { name: "serena", status: "failed" },
      ],
      skills: ["deep-research", "code-review"],
      slashCommands: ["review", "commit"],
      agents: ["Explore", "general-purpose"],
    });
  });

  it("defaults empty arrays and omits model on a malformed/partial init (never throws)", () => {
    const ext = extractExtensions({ type: "system", subtype: "init" }, "/cwd");
    expect(ext).toEqual({ cwd: "/cwd", mcp: [], skills: [], slashCommands: [], agents: [] });
    expect(ext).not.toHaveProperty("model");
  });

  it("survives a totally non-object init (null / string / number) with empty arrays", () => {
    for (const bad of [null, "nope", 42, undefined]) {
      const ext = extractExtensions(bad, "/cwd");
      expect(ext).toEqual({ cwd: "/cwd", mcp: [], skills: [], slashCommands: [], agents: [] });
    }
  });

  it("filters mcp entries lacking a string name and coerces a missing status to 'unknown'", () => {
    const ext = extractExtensions(
      {
        mcp_servers: [
          { name: "ok", status: "connected" },
          { name: "no-status" }, // status missing -> "unknown"
          { status: "connected" }, // no name -> dropped
          { name: 42, status: "connected" }, // non-string name -> dropped
          "garbage", // non-object -> dropped
        ],
      },
      "/cwd",
    );
    expect(ext.mcp).toEqual([
      { name: "ok", status: "connected" },
      { name: "no-status", status: "unknown" },
    ]);
  });

  it("drops non-string entries from the string arrays", () => {
    const ext = extractExtensions(
      { skills: ["a", 1, null, "b"], slash_commands: [{}, "s"], agents: ["x", false] },
      "/cwd",
    );
    expect(ext.skills).toEqual(["a", "b"]);
    expect(ext.slashCommands).toEqual(["s"]);
    expect(ext.agents).toEqual(["x"]);
  });
});

describe("probeAgentExtensions (injected spawnInit — no real spawn)", () => {
  it("builds the stream-json args (with isolation flags appended) and returns the extracted set", async () => {
    let captured: { exe: string; cwd: string; args: string[]; stdin: string } | undefined;
    const spawnInit: SpawnInit = async (opts) => {
      captured = opts;
      return REALISTIC_INIT;
    };
    const ext = await probeAgentExtensions({
      exe: "claude",
      cwd: "/repo/root",
      model: "haiku",
      isolationFlags: ["--bare"],
      spawnInit,
    });
    expect(ext).not.toBeNull();
    expect(ext!.cwd).toBe("/repo/root");
    expect(ext!.mcp).toHaveLength(2);
    // args: -p --model haiku --permission-mode acceptEdits --max-turns 1 --verbose --output-format stream-json --bare
    expect(captured!.exe).toBe("claude");
    expect(captured!.cwd).toBe("/repo/root");
    expect(captured!.args).toEqual([
      "-p",
      "--model",
      "haiku",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "1",
      "--verbose",
      "--output-format",
      "stream-json",
      "--bare",
    ]);
    expect(captured!.stdin.length).toBeGreaterThan(0);
  });

  it("returns null when the spawner sees no init event", async () => {
    const spawnInit: SpawnInit = async () => null;
    const ext = await probeAgentExtensions({
      exe: "claude",
      cwd: "/repo",
      model: "haiku",
      isolationFlags: [],
      spawnInit,
    });
    expect(ext).toBeNull();
  });

  it("never rejects — a throwing spawner degrades to null", async () => {
    const spawnInit: SpawnInit = async () => {
      throw new Error("boom");
    };
    const ext = await probeAgentExtensions({
      exe: "claude",
      cwd: "/repo",
      model: "haiku",
      isolationFlags: [],
      spawnInit,
    });
    expect(ext).toBeNull();
  });

  it("appends nothing when isolationFlags is empty (byte-identical baseline args tail)", async () => {
    let captured: string[] | undefined;
    const spawnInit: SpawnInit = async (opts) => {
      captured = opts.args;
      return REALISTIC_INIT;
    };
    await probeAgentExtensions({ exe: "claude", cwd: "/r", model: "sonnet", isolationFlags: [], spawnInit });
    expect(captured![captured!.length - 1]).toBe("stream-json");
  });
});

/** Minimal fake child for the DEFAULT streaming spawner — enough surface for
 *  `stdout.setEncoding/on`, `stdin.on/end`, child `on('error'|'close')`, `kill`. */
class FakeStdout extends EventEmitter {
  setEncoding(): void {
    /* no-op (tests emit already-decoded strings) */
  }
}
class FakeChild extends EventEmitter {
  stdout = new FakeStdout();
  stdin = Object.assign(new EventEmitter(), { end: (): void => {} });
  kills: string[] = [];
  kill(sig: string): boolean {
    this.kills.push(sig);
    return true;
  }
}

describe("makeStreamingSpawnInit (default spawner — fake child, no real spawn)", () => {
  const run = (child: FakeChild): Promise<unknown | null> => {
    const spawnFn = (() => child) as unknown as SpawnFn;
    return makeStreamingSpawnInit(20000, spawnFn)({ exe: "claude", cwd: "/r", args: [], stdin: "x" });
  };

  it("resolves the first system/init event and SIGTERMs the child", async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stdout.emit("data", JSON.stringify({ type: "system", subtype: "init", model: "m" }) + "\n");
    child.emit("close", 0); // dies from the SIGTERM -> clears the SIGKILL grace timer
    await expect(p).resolves.toMatchObject({ type: "system", subtype: "init", model: "m" });
    expect(child.kills).toContain("SIGTERM");
  });

  it("caps an un-newlined runaway line: settles null and kills (Medium fix)", async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stdout.emit("data", "x".repeat(MAX_REMAINDER_BYTES + 1)); // no newline, over the cap
    child.emit("close", 0);
    await expect(p).resolves.toBeNull();
    expect(child.kills).toContain("SIGTERM");
  });

  it("never rejects on a synchronous spawn failure — resolves null (Low fix: SpawnInit contract)", async () => {
    const spawnFn = (() => {
      throw new Error("ENOENT: spawn failed");
    }) as unknown as SpawnFn;
    await expect(
      makeStreamingSpawnInit(20000, spawnFn)({ exe: "nope", cwd: "/r", args: [], stdin: "x" }),
    ).resolves.toBeNull();
  });

  it("resolves null when the child closes with no init event seen", async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stdout.emit("data", '{"type":"system","subtype":"hook_started"}\n'); // not init
    child.emit("close", 0);
    await expect(p).resolves.toBeNull();
  });
});
