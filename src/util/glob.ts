/**
 * Glob matcher with parity to the PS `Test-GlobMatch`:
 *  - paths normalized to forward slashes
 *  - `**` matches any number of characters INCLUDING `/`
 *  - `*`  matches any characters EXCEPT `/` (within one path segment)
 *  - `?`  matches a single non-`/` character
 * Case-sensitive. Anchored (must match the whole path).
 */
export function globMatch(pattern: string, path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const re = globToRegExp(pattern.replace(/\\/g, "/"));
  return re.test(p);
}

/**
 * Normalize a path the same way as the PS `ConvertTo-NormalizedPath`:
 * backslashes become forward slashes, then leading `.` and `/` characters
 * are stripped (mirrors `.TrimStart('./')`, which trims BOTH chars, not the
 * literal 2-char prefix). Used ONLY for set-comparison (stray/forbidden/prefix
 * checks) — never for reading files, since it would break a raw `.autodev/...`
 * path by stripping its leading dot.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^[./]+/, "");
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — matches across segments, optionally consuming a following `/`
        // so a trailing `*` in the rest of the pattern stays segment-local.
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // zero-or-more full segments, including none
        } else {
          re += ".*"; // bare trailing `**` matches everything remaining
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re);
}
