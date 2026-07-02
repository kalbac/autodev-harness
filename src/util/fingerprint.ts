import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globMatch, normalizePath } from "./glob.js";

/** Hex-lowercase SHA256 of a byte buffer. */
export function bytesSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Map of RAW git path -> content fingerprint, for the given changed paths.
 * Reads each file under `repoRoot`. A present file -> its sha256; an absent
 * file -> "<absent>"; an unreadable file -> "<unreadable>". Skips empty/blank paths.
 * Keyed by the RAW (un-normalized) path so the file can actually be read.
 */
export function snapshot(repoRoot: string, rawPaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of rawPaths) {
    if (!f || f.trim() === "") continue;
    const full = join(repoRoot, f);
    if (existsSync(full)) {
      try {
        map.set(f, bytesSha256(readFileSync(full)));
      } catch {
        map.set(f, "<unreadable>");
      }
    } else {
      map.set(f, "<absent>");
    }
  }
  return map;
}

/**
 * Pure: raw paths whose fingerprint is NEW or CHANGED vs the pre-worker baseline.
 * (A brand-new dirty file AND a further edit to an already-dirty file both count;
 * an untouched pre-existing-dirty file keeps its fingerprint and is excluded.)
 */
export function workerTouched(baseline: Map<string, string>, now: Map<string, string>): string[] {
  const touched: string[] = [];
  for (const [k, v] of now) {
    if (!baseline.has(k) || baseline.get(k) !== v) touched.push(k);
  }
  return touched;
}

/**
 * Pure: which changed files are OUTSIDE `fileSet` AND not under an ignored prefix?
 * Normalize both sides. `ignorePrefixes` entries ending in "/" match the dir and
 * anything under it (boundary-safe: "a/" matches "a/x" and "a" but NOT "ab");
 * entries without a trailing "/" match only an exact equal path.
 * (Parity: Get-AutodevStrayChangedFiles + Test-AutodevPathUnderAnyPrefix.)
 */
export function strayChanged(touched: string[], fileSet: string[], ignorePrefixes: string[]): string[] {
  const owned = new Set(fileSet.map(normalizePath));
  const stray: string[] = [];
  for (const f of touched) {
    const n = normalizePath(f);
    if (owned.has(n)) continue;
    if (isUnderAnyPrefix(n, ignorePrefixes)) continue;
    stray.push(n);
  }
  return stray;
}

function isUnderAnyPrefix(normalizedPath: string, prefixes: string[]): boolean {
  for (const pre of prefixes) {
    const n = normalizePath(pre);
    if (n.endsWith("/")) {
      if (normalizedPath === n.slice(0, -1) || normalizedPath.startsWith(n)) return true;
    } else {
      if (normalizedPath === n) return true;
    }
  }
  return false;
}

/** Pure: which changed files match any of the forbidden globs? Returns normalized paths. Empty globs -> []. */
export function forbiddenTouches(touched: string[], forbiddenGlobs: string[]): string[] {
  const hit: string[] = [];
  if (forbiddenGlobs.length === 0) return hit;
  // Parity: PS `Test-GlobMatch` runs `ConvertTo-NormalizedPath` over BOTH the
  // path and the glob before matching. Normalizing only the returned hit (not
  // the match input) would let a `./`-prefixed changed path slip past a
  // forbidden glob — a fail-open on a security-relevant check.
  for (const f of touched) {
    const n = normalizePath(f);
    if (forbiddenGlobs.some((g) => globMatch(normalizePath(g), n))) hit.push(n);
  }
  return hit;
}
