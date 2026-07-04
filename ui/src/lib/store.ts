import { create } from "zustand";

export type ConnState = "connecting" | "live" | "offline";

interface AppStore {
  /** Live WS link to the daemon (drives the sidebar status dot). */
  conn: ConnState;
  setConn: (c: ConnState) => void;
  /** "Re-run" seed: an intent stashed by RunView's re-run action, read + cleared
   *  by NewRunComposer on mount so the composer opens pre-filled (no backend fork —
   *  re-running an intent is just POST /orchestrate again). null = nothing seeded. */
  composerSeed: string | null;
  setComposerSeed: (s: string) => void;
  clearComposerSeed: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  conn: "connecting",
  setConn: (conn) => set({ conn }),
  composerSeed: null,
  setComposerSeed: (composerSeed) => set({ composerSeed }),
  clearComposerSeed: () => set({ composerSeed: null }),
}));
