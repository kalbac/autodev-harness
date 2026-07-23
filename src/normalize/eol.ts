/**
 * Normalize a worker's changed files toward LF before the gate reads them.
 *
 * A worker running on Windows writes a new file with CRLF (an OS/editor artifact,
 * not a choice). The `wordpress-woocommerce` profile's WPCS ruleset includes the
 * `Generic.Files.LineEndings` sniff, which (correctly, on that platform) reds a
 * brand-new file at line 1 -- and for a NEW file, line 1 is a worker-added line, so
 * line-scoping (`src/gate/finding-filter.ts`) cannot filter it as pre-existing. The
 * worker cannot fix it (rewriting on Windows re-introduces CRLF), so the task burns
 * its attempt budget and escalates. This module removes the artifact at its root:
 * it rewrites `\r\n` -> `\n` in the worker's changed files, so the diff, the critic,
 * the gate, and the commit all see LF -- exactly what git itself would produce on
 * commit under the repo's `.gitattributes`.
 *
 * The EOL policy is the TARGET REPO's own `.gitattributes`, resolved via
 * `git check-attr` (never re-implemented here), with LF the default when the repo is
 * silent. Fail toward NOT mangling (Principle 10): a declared-binary file, an
 * `eol=crlf` file, or an undeclared file whose bytes contain a NUL is left untouched.
 * The module is BEST-EFFORT: any failure leaves files as-is (the pre-existing, safe
 * behavior -- the sniff may red a new file, which parks the task, it does not merge
 * bad output), and it never throws to the conductor.
 *
 * Design: `docs/superpowers/specs/2026-07-23-eol-normalization-design.md`.
 */
import { runNative } from "../util/native.js";
import { readFile as fsReadFile, writeFile as fsWriteFile, lstat as fsLstat } from "node:fs/promises";
import { join } from "node:path";
import { realpathContains } from "../util/path-contain.js";

/** git's own attribute vocabulary. `text: "unset"` is the `-text` "binary"
 *  declaration; `"unspecified"` means no attribute matched the path. */
export interface GitAttr {
  text: "set" | "unset" | "unspecified";
  eol: "lf" | "crlf" | "unspecified";
}

export interface NormalizeResult {
  /** Worktree-relative paths whose CRLF was rewritten to LF. */
  normalized: string[];
  /** Worktree-relative paths skipped because they looked binary (declared `-text`,
   *  or undeclared with a NUL byte). */
  skippedBinary: string[];
}

export interface NormalizeEolDeps {
  checkAttr: (worktreePath: string, relPaths: string[]) => Promise<Map<string, GitAttr>>;
  /** lstat (does NOT follow a leaf symlink) for the regular-file guard. */
  lstat: (absPath: string) => Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean }>;
  /** True iff absPath, fully realpath-resolved, is contained under worktreePath.
   *  Closes an intermediate-symlinked-directory / `..` escape that lstat alone cannot see. */
  realpathContains: (worktreePath: string, absPath: string) => Promise<boolean>;
  readFile: (absPath: string) => Promise<Buffer>;
  writeFile: (absPath: string, data: Buffer) => Promise<void>;
  log: (level: string, message: string) => void;
}

/**
 * Parse `git check-attr -z text eol -- <files>` output: NUL-terminated triples
 * `path\0attr\0value\0`, repeated. Groups the per-path `text` and `eol` values into
 * one `GitAttr`. A path with a missing attr record defaults that field to
 * `"unspecified"`.
 */
export function parseCheckAttr(stdout: string): Map<string, GitAttr> {
  const out = new Map<string, GitAttr>();
  const tokens = stdout.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i + 3 <= tokens.length; i += 3) {
    const path = tokens[i]!;
    const attr = tokens[i + 1]!;
    const value = tokens[i + 2]!;
    let rec = out.get(path);
    if (!rec) {
      rec = { text: "unspecified", eol: "unspecified" };
      out.set(path, rec);
    }
    if (attr === "text") {
      rec.text = value === "set" ? "set" : value === "unset" ? "unset" : "unspecified";
    } else if (attr === "eol") {
      rec.eol = value === "lf" ? "lf" : value === "crlf" ? "crlf" : "unspecified";
    }
  }
  return out;
}

/** Decide the LF-normalization action for one file given its git attributes and a
 *  binary-heuristic hint.
 *  - declared binary (`text: "unset"`) -> skip.
 *  - `eol: "crlf"` -> skip (repo explicitly wants CRLF).
 *  - `eol: "lf"` OR `text: "set"` -> normalize (an explicit declaration is the
 *    operator's word; it overrides the NUL guard).
 *  - otherwise (unspecified) -> normalize UNLESS the bytes look binary (NUL present). */
function decide(attr: GitAttr, looksBinary: boolean): "normalize" | "skip" | "skip-binary" {
  if (attr.text === "unset") return "skip-binary";
  if (attr.eol === "crlf") return "skip";
  if (attr.eol === "lf" || attr.text === "set") return "normalize";
  return looksBinary ? "skip-binary" : "normalize";
}

const CR = 0x0d;
const LF = 0x0a;
const NUL_BYTE = 0x00;

/** Rewrite every CRLF to LF in a buffer. `changed` is false when there was no CRLF at
 *  all, so the caller can cheaply detect "nothing to write". A lone `\r` (old-Mac) is
 *  deliberately left alone -- the observed artifact is specifically CRLF. */
function crlfToLf(buf: Buffer): { out: Buffer; changed: boolean } {
  if (!buf.includes(CR)) return { out: buf, changed: false };
  const result: number[] = [];
  let changed = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === CR && i + 1 < buf.length && buf[i + 1] === LF) {
      changed = true;
      continue;
    }
    result.push(buf[i]!);
  }
  return { out: Buffer.from(result), changed };
}

/** Guarded string conversion -- a broken/hostile `err.toString` must not itself throw
 *  out of the best-effort path. */
function describeError(err: unknown): string {
  try {
    return String(err);
  } catch {
    return "<unstringifiable error>";
  }
}

/**
 * Normalize the worker's changed files toward LF. Best-effort and non-throwing: a
 * `checkAttr` failure normalizes nothing (WARN + empty result); a per-file read/write
 * failure skips that one file (WARN) and continues.
 */
export async function normalizeWorktreeEol(
  deps: NormalizeEolDeps,
  worktreePath: string,
  relPaths: string[],
): Promise<NormalizeResult> {
  const result: NormalizeResult = { normalized: [], skippedBinary: [] };
  if (relPaths.length === 0) return result;

  // The module's contract is "never throws" and the conductor calls it with no
  // try/catch on that promise -- so even the error path (logging) must be guarded:
  // `deps.log` is the composition root's file logger, which can throw a failed write.
  // (docs/gotchas/never-throws-catch-block-logging.md.)
  const safeLog = (level: string, message: string): void => {
    try {
      deps.log(level, message);
    } catch {
      /* a best-effort module must not fail because its logger failed */
    }
  };

  let attrs: Map<string, GitAttr>;
  try {
    attrs = await deps.checkAttr(worktreePath, relPaths);
  } catch (err) {
    safeLog("WARN", `normalizeWorktreeEol: git check-attr failed, normalizing nothing this task: ${describeError(err)}`);
    return result;
  }

  for (const rel of relPaths) {
    const attr = attrs.get(rel) ?? { text: "unspecified", eol: "unspecified" };
    const abs = join(worktreePath, rel);
    try {
      // CONTAINMENT + REGULAR-FILE GUARD (fail-closed, Principle 10). A worker can put
      // a SYMLINK in its file_set; normalizing through it would read/write OUTSIDE the
      // worktree. lstat (no leaf-link follow) rejects a symlink/dir/fifo leaf;
      // realpathContains additionally rejects an escape via an intermediate symlinked
      // directory or a `..` segment. An unverifiable target is skipped, never written.
      // (docs/gotchas/static-file-serving-symlink-traversal.md; util/path-contain.ts.)
      //
      // ACCEPTED RESIDUAL -- the check->use (lstat/realpathContains -> readFile/
      // writeFile) window is a TOCTOU: a concurrent actor swapping `abs` (or a parent
      // dir) for a symlink between the check and the write could still escape. This is
      // the SAME residual the oracle fence accepts (the realpath->open gap in
      // util/path-contain.ts consumers), and closing it needs `openat2`/O_NOFOLLOW on
      // every path component, which Node does not expose portably (this is a
      // cross-platform product). It is not exploitable in practice here: the conductor
      // is single-threaded and the worker process has already terminated before
      // normalization runs, so no harness actor writes the worktree during this window.
      // Named, not closed -- do not pretend a portable full fix exists.
      const st = await deps.lstat(abs);
      if (!st.isFile() || st.isSymbolicLink()) {
        safeLog("WARN", `normalizeWorktreeEol: skipping ${rel} (not a regular file -- symlink/dir/other)`);
        continue;
      }
      if (!(await deps.realpathContains(worktreePath, abs))) {
        safeLog("WARN", `normalizeWorktreeEol: skipping ${rel} (resolves outside the worktree)`);
        continue;
      }

      const buf = await deps.readFile(abs);
      const looksBinary = buf.includes(NUL_BYTE);
      const action = decide(attr, looksBinary);
      if (action === "skip-binary") {
        result.skippedBinary.push(rel);
        continue;
      }
      if (action === "skip") continue;
      const { out, changed } = crlfToLf(buf);
      if (!changed) continue;
      await deps.writeFile(abs, out);
      result.normalized.push(rel);
    } catch (err) {
      safeLog("WARN", `normalizeWorktreeEol: skipping ${rel} (read/write failed): ${describeError(err)}`);
    }
  }

  return result;
}

/**
 * Real `git check-attr` for a worktree: one batched call over all `relPaths` using
 * `-z` (NUL-delimited, so paths with spaces/UTF-8 are safe). Run with cwd = the
 * worktree so the worktree's own `.gitattributes` applies. Attributes resolve by path
 * PATTERN, not tracking status, so a brand-new (untracked) file is handled correctly.
 */
export async function gitCheckAttr(worktreePath: string, relPaths: string[]): Promise<Map<string, GitAttr>> {
  if (relPaths.length === 0) return new Map();
  const r = await runNative("git", ["check-attr", "-z", "text", "eol", "--", ...relPaths], { cwd: worktreePath });
  if (r.exitCode !== 0) {
    throw new Error(`git check-attr failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  }
  return parseCheckAttr(r.stdout);
}

/** Default deps binding the real git call + node fs. `log` is injected by the caller
 *  so this module has no logging dependency of its own. */
export function makeNormalizeEolDeps(log: (level: string, message: string) => void): NormalizeEolDeps {
  return {
    checkAttr: gitCheckAttr,
    lstat: (abs) => fsLstat(abs),
    realpathContains: (wt, abs) => realpathContains(wt, abs),
    readFile: (abs) => fsReadFile(abs),
    writeFile: (abs, data) => fsWriteFile(abs, data),
    log,
  };
}
