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
