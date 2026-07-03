import { create } from "zustand";

export type ConnState = "connecting" | "live" | "offline";

interface AppStore {
  /** Live WS link to the daemon (drives the sidebar status dot). */
  conn: ConnState;
  setConn: (c: ConnState) => void;
  /**
   * Interim multi-project shim (see `lib/api.ts` module header): the FIRST
   * project returned by `GET /projects`, resolved once at boot by
   * `components/ProjectGate.tsx`. `null` until resolved. A later module
   * replaces this with a real project picker/switcher.
   */
  projectId: string | null;
  setProjectId: (id: string) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  conn: "connecting",
  setConn: (conn) => set({ conn }),
  projectId: null,
  setProjectId: (projectId) => set({ projectId }),
}));
