# `[api/413-teardown]` — destroying an HTTP socket before flushing the response = client reset, not 413

**Tag:** `[api/413-teardown]`
**Found:** s08 (2026-07-01), Task 27 `src/api/server.ts` body-size cap.

## Symptom

The oversized-body guard was supposed to return **HTTP 413**. The test client (`fetch`/
undici) instead saw `TypeError: fetch failed … SocketError: other side closed`
(`UND_ERR_SOCKET`) — a connection reset, never a 413.

## Cause

The first fix called `req.destroy()` **inside the body reader** the moment the byte cap
was exceeded. Destroying the request tears down the underlying socket immediately — so
the 413 response the handler wrote afterward had no socket to flush to. The client got a
reset instead of the status.

## Fix

Split "stop the memory growth" from "tear down the connection", and order them:

1. In the reader, on overflow: **stop appending** (memory stays bounded), set an
   `overflowed` flag, `reject(new PayloadTooLargeError())`. Do NOT destroy here.
2. In the handler's catch: write the 413 **with `connection: close`**, `res.end(...)`,
   then destroy the socket only once the response has flushed:
   ```ts
   res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
   res.end(JSON.stringify({ error: "request body too large" }));
   res.on("finish", () => req.destroy()); // teardown AFTER the response is on the wire
   ```

This bounds memory (later chunks are discarded, not buffered), still returns a clean
413, and guarantees a never-ending upload can't keep the connection — and therefore
`server.close()` — alive (an `[ts/test-hang]` adjacency).

## Lesson

To answer a request while rejecting its body, the response must reach the client
**before** the socket dies. `req.destroy()` is a connection kill, not a body-abort —
sequence it on `res`'s `finish`, never eagerly.

## Related
- `[ts/test-hang]` — an unterminated/uncleaned handle stalls vitest; `close()` must tear down live sockets.
- `docs/superpowers/donor-extraction/autodev-loop-parity-spec.md` §8 — the reply endpoint is a named injection surface (why the body cap matters there).
