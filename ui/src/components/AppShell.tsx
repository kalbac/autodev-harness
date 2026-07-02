import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

/** Two-region agent-desktop shell: persistent left rail + the routed main area. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-ink text-text">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-hidden">{children}</main>
    </div>
  );
}
