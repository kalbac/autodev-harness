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
  // Keyed by id, but the record carries the PATH the root was built for. The
  // registry can be hand-edited so an id points at a different repo; a root
  // cached under the old path must NOT be served for the new one (it would
  // serve/orchestrate the wrong repo), so every hit checks path equality.
  const roots = new Map<string, { path: string; promise: Promise<R> }>();
  const lastError = new Map<string, string>();

  return {
    async list(): Promise<ProjectSummary[]> {
      const entries = await deps.loadEntries();
      return entries.map((e) => {
        const err = lastError.get(e.id);
        // "ready" only when a root is cached FOR THIS PATH -- a moved project
        // whose cached root is for the old path shows "unbuilt" until rebuilt.
        if (roots.get(e.id)?.path === e.path) return { id: e.id, name: e.name, path: e.path, status: "ready" };
        if (err !== undefined) return { id: e.id, name: e.name, path: e.path, status: "error", error: err };
        return { id: e.id, name: e.name, path: e.path, status: "unbuilt" };
      });
    },

    async get(id: string): Promise<HubGetResult<R>> {
      const entries = await deps.loadEntries();
      const entry = entries.find((e) => e.id === id);
      if (!entry) return null;

      const existing = roots.get(id);
      if (existing && existing.path !== entry.path) {
        // Registry now points this id at a different path -> the cached root is for
        // the OLD repo; drop it (and any stale error) and rebuild for the new path.
        roots.delete(id);
        lastError.delete(id);
      }

      const cached = roots.get(id);
      if (cached) {
        try {
          return { root: await cached.promise };
        } catch (err) {
          // A concurrent caller that piggy-backed on the in-flight build must also
          // get {error} -- not an escaped rejection (which would surface as a 500
          // instead of the 503 the {error} branch produces). A concurrent retry may
          // already have replaced the record, so only evict the one we awaited.
          if (roots.get(id) === cached) roots.delete(id);
          const message = err instanceof Error ? err.message : String(err);
          lastError.set(id, message);
          return { error: message };
        }
      }

      const record = { path: entry.path, promise: deps.buildRoot(entry) };
      roots.set(id, record); // set BEFORE await: concurrent get()s share the in-flight build
      try {
        const root = await record.promise;
        lastError.delete(id);
        return { root };
      } catch (err) {
        // Not cached -> a later get() retries after the operator fixes the config.
        // Only evict our own record: a concurrent path-change retry may have replaced it.
        if (roots.get(id) === record) roots.delete(id);
        const message = err instanceof Error ? err.message : String(err);
        lastError.set(id, message);
        deps.log?.("ERROR", `hub: failed to build project '${id}' (${entry.path}): ${message}`);
        return { error: message };
      }
    },
  };
}
