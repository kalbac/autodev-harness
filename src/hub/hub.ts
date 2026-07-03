import type { RegistryEntry } from "../registry/registry.js";

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  /** "unbuilt" = never requested; "ready" = root built; "error" = last build failed. */
  status: "unbuilt" | "ready" | "error";
  /** Present only when status === "error". */
  error?: string;
}

export type HubGetResult<R> = { root: R } | { error: string } | null;

export interface ProjectHub<R> {
  /** Registry entries + build status. NEVER forces a build (the sidebar must
   *  render instantly even when a project's config is broken). */
  list(): Promise<ProjectSummary[]>;
  /** Lazily build (and cache) the project's composition root. Unknown id -> null.
   *  Build failure -> {error} — NOT cached, so fixing config.yaml + retrying works. */
  get(id: string): Promise<HubGetResult<R>>;
}

/**
 * One composition root per registered project, built on first use. A failing
 * build (bad config.yaml, missing path) is isolated to that project: it
 * reports an error state and never poisons siblings or crashes serve.
 */
export function createProjectHub<R>(deps: {
  loadEntries: () => Promise<RegistryEntry[]>;
  buildRoot: (entry: RegistryEntry) => Promise<R>;
  log?: (level: string, message: string) => void;
}): ProjectHub<R> {
  const roots = new Map<string, Promise<R>>();
  const lastError = new Map<string, string>();

  return {
    async list(): Promise<ProjectSummary[]> {
      const entries = await deps.loadEntries();
      return entries.map((e) => {
        const err = lastError.get(e.id);
        if (roots.has(e.id)) return { id: e.id, name: e.name, path: e.path, status: "ready" };
        if (err !== undefined) return { id: e.id, name: e.name, path: e.path, status: "error", error: err };
        return { id: e.id, name: e.name, path: e.path, status: "unbuilt" };
      });
    },

    async get(id: string): Promise<HubGetResult<R>> {
      const entries = await deps.loadEntries();
      const entry = entries.find((e) => e.id === id);
      if (!entry) return null;

      const cached = roots.get(id);
      if (cached) {
        return { root: await cached };
      }

      const building = deps.buildRoot(entry);
      roots.set(id, building); // set BEFORE await: concurrent get()s share the in-flight build
      try {
        const root = await building;
        lastError.delete(id);
        return { root };
      } catch (err) {
        roots.delete(id); // not cached -> a later get() retries after the operator fixes the config
        const message = err instanceof Error ? err.message : String(err);
        lastError.set(id, message);
        deps.log?.("ERROR", `hub: failed to build project '${id}' (${entry.path}): ${message}`);
        return { error: message };
      }
    },
  };
}
