/**
 * Tolerant JSON-ARRAY extraction (mirrors `critic/verdict.ts`'s tolerant
 * `{...}` object extraction, but for a top-level `[...]` array): a model's
 * output is often surrounded by prose despite an "ONLY JSON" instruction.
 *
 * Naive "first `[` .. last `]`" slicing breaks when prose contains a stray
 * bracket (e.g. "Here are tasks [draft]\n[{...}]" — the naive slice would
 * span from the prose bracket all the way to the real close, capturing
 * invalid JSON in between). Instead, this scans every index where a `[`
 * occurs, and for each one attempts to find ITS balanced matching `]`
 * (tracking bracket depth while ignoring bracket characters that appear
 * inside JSON string literals — respecting `"..."` with `\"` escapes so a
 * bracket inside a title like `"fix [x]"` doesn't perturb the depth count).
 * The first candidate slice that both balances AND parses to a top-level
 * array is returned. Returns `null` (never throws) if no candidate
 * qualifies — the caller decides how to react.
 */
export function extractJsonArray(text: string): unknown[] | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;

    const end = findBalancedArrayEnd(text, i);
    if (end === -1) continue;

    const candidate = text.slice(i, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (Array.isArray(parsed)) {
      return parsed;
    }
  }

  return null;
}

/**
 * Starting at `start` (which must point at a `[`), scan forward tracking
 * bracket depth — `[` / `]` outside of string literals adjust depth,
 * anything inside a `"..."` string (respecting `\"` escapes) is ignored —
 * and return the index of the `]` where depth returns to 0. Returns -1 if
 * the brackets never balance before the text ends.
 */
export function findBalancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === "\\") {
        i++; // skip the escaped character (e.g. \" or \\)
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}
