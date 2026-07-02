import { create } from "zustand";

export type ConnState = "connecting" | "live" | "offline";

interface AppStore {
  /** Live WS link to the daemon (drives the sidebar status dot). */
  conn: ConnState;
  setConn: (c: ConnState) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  conn: "connecting",
  setConn: (conn) => set({ conn }),
}));
