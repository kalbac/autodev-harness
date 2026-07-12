const FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

/**
 * Removes ```json ... ``` fenced blocks from text, verbatim (no cosmetic
 * newline collapsing). This is intentional: the StreamingFenceStripper
 * below cannot easily reproduce whitespace-collapse cosmetics while
 * streaming token-by-token, so the batch function is kept to the same
 * raw-removal semantics to guarantee byte-identical agreement between
 * live-stream output and replayed/batch output.
 */
export function stripFencedJson(text: string): string {
  return text.replace(/```json[\s\S]*?```/g, "");
}

/**
 * Incremental counterpart to stripFencedJson. Fed arbitrary chunks (down to
 * single characters), it forwards prose immediately while buffering only the
 * minimum lookback needed to detect a fence delimiter that may be split
 * across chunk boundaries. It must produce output byte-identical to
 * stripFencedJson(fullText) when all push() outputs plus end() are
 * concatenated.
 */
export class StreamingFenceStripper {
  private buf = "";
  private inFence = false;

  push(chunk: string): string {
    this.buf += chunk;
    let emit = "";
    for (;;) {
      if (!this.inFence) {
        const open = this.buf.indexOf(FENCE_OPEN);
        if (open === -1) {
          const safe = this.buf.length - (FENCE_OPEN.length - 1);
          if (safe > 0) { emit += this.buf.slice(0, safe); this.buf = this.buf.slice(safe); }
          break;
        }
        emit += this.buf.slice(0, open);
        this.buf = this.buf.slice(open + FENCE_OPEN.length);
        this.inFence = true;
      } else {
        const close = this.buf.indexOf(FENCE_CLOSE);
        if (close === -1) {
          const safe = this.buf.length - (FENCE_CLOSE.length - 1);
          if (safe > 0) this.buf = this.buf.slice(safe);
          break;
        }
        this.buf = this.buf.slice(close + FENCE_CLOSE.length);
        this.inFence = false;
      }
    }
    return emit;
  }

  end(): string {
    const rest = this.inFence ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}
