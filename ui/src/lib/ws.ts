import type { QueryClient } from "@tanstack/react-query";
import { useAppStore } from "./store";
import { router } from "../router";

/**
 * Connects the daemon's root WebSocket (`{type:"change", projectId, path}`) to
 * React Query: every change event FOR THE ACTIVE-ROUTE PROJECT debounces (150ms)
 * then invalidates ALL queries, so any mounted view re-fetches. A change event
 * for a DIFFERENT project is ignored — the WS stream is shared across every
 * registered project, but the dashboard only renders the one in the router path
 * (`/p/:projectId/...`). This mirrors AO's SSE→invalidate pattern; the WS
 * carries no payload into components — it is purely an invalidation signal.
 *
 * The page is same-origin with the daemon in production (the daemon serves this
 * bundle), so `location.host` is the daemon. In dev, Vite serves the page on a
 * different port, so we dial the daemon origin directly (Vite doesn't proxy the
 * root-path WS). Returns a disposer.
 */
export function connectWs(queryClient: QueryClient): () => void {
  const setConn = useAppStore.getState().setConn;

  const wsUrl = import.meta.env.DEV
    ? "ws://127.0.0.1:4319"
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const invalidateSoon = (): void => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void queryClient.invalidateQueries();
    }, 150);
  };

  const open = (): void => {
    if (closed) return;
    setConn("connecting");
    ws = new WebSocket(wsUrl);

    ws.onopen = () => setConn("live");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; projectId?: string };
        if (msg?.type !== "change") return;
        // Ignore a change event for a project other than the one in the active
        // route path (`/p/:projectId/...`). Off a project route (e.g. `/new`)
        // there is no active project, so every change is dropped. `projectId`
        // should always be present now; a message missing it (unexpected/legacy)
        // is treated as "not ours" and dropped rather than over-invalidating.
        const m = router.state.location.pathname.match(/^\/p\/([^/]+)/);
        const selected = m ? decodeURIComponent(m[1]!) : null;
        if (!selected || msg.projectId !== selected) return;
        invalidateSoon();
      } catch {
        /* ignore non-JSON frames */
      }
    };
    ws.onclose = () => {
      setConn("offline");
      if (closed) return;
      // Reconnect with a fixed 3s backoff, then refetch once on reopen so a
      // missed-while-offline change is not lost.
      retry = setTimeout(() => {
        void queryClient.invalidateQueries();
        open();
      }, 3000);
    };
    ws.onerror = () => ws?.close();
  };

  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    if (debounce) clearTimeout(debounce);
    ws?.close();
  };
}
