import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The daemon's `serve` verb binds 127.0.0.1:4319 by default and serves this
// build's output (../dist/ui) as the SPA fallback in production. In dev we run
// Vite separately and proxy the read/write API routes to that daemon. The WS
// (mounted at the daemon's server root) is NOT proxied here -- the client dials
// the daemon origin directly in dev (see src/lib/ws.ts) to avoid a root-path
// proxy swallowing every request.
const DAEMON = "http://127.0.0.1:4319";
const apiProxy = { target: DAEMON, changeOrigin: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Production bundle lands where the daemon's `serve` verb looks for it.
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/state": apiProxy,
      "/runs": apiProxy,
      "/tasks": apiProxy,
      "/escalations": apiProxy,
      "/orchestrate": apiProxy,
    },
  },
});
