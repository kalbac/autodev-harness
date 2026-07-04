/**
 * Project admin for the New Project flow (spec §5/§6): register (validate →
 * scaffold → registry append), unregister (registry entry ONLY — never touches
 * the project folder), and the registry-membership check the folder browser
 * annotates with. Every registry read-modify-write runs through a promise-chain
 * mutex: the registry is a single JSON file with plain-overwrite saves, so two
 * concurrent POST /projects handled without serialization would race
 * (last-writer-wins) and silently lose one entry.
 */
import { stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadRegistry,
  saveRegistry,
  addProject,
  removeProject,
  renameProject,
  isPathRegistered,
  type RegistryEntry,
} from "./registry.js";
import { scaffoldProject, ScaffoldConfigError, ScaffoldFormSchema } from "./scaffold.js";

type Log = (level: string, message: string) => void;

export interface RegisterInput {
  path: string;
  name?: string;
  /** Default true (spec §5: scaffold checkbox default ON). Safe: scaffold
   *  self-skips when `.autodev/config.yaml` already exists. */
  scaffold?: boolean;
  /** Raw form values from the HTTP body — validated here via `ScaffoldFormSchema`. */
  config?: unknown;
}

export type RegisterErrorCode = "invalid_path" | "not_a_git_repo" | "already_registered" | "invalid_config";

export type RegisterResult =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; code: RegisterErrorCode; message: string };

export type RenameErrorCode = "not_found" | "invalid_name";

export type RenameResult =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; code: RenameErrorCode; message: string };

export interface ProjectAdmin {
  register(input: RegisterInput): Promise<RegisterResult>;
  /** True when removed; false for an unknown id. Registry entry only. */
  unregister(id: string): Promise<boolean>;
  /** Set a project's display name by id. Registry entry only — never touches the folder. */
  rename(id: string, name: string): Promise<RenameResult>;
  /** Registry membership by canonical path (folder-browser badge). */
  isRegistered(absPath: string): Promise<boolean>;
}

export function createProjectAdmin(deps: { registryFile: string; log?: Log }): ProjectAdmin {
  // Promise-chain mutex. `chain` is always a settled-or-pending SWALLOWED promise
  // (never rejected), so one failed operation can never wedge the queue.
  let chain: Promise<void> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    register(input) {
      return withLock(async (): Promise<RegisterResult> => {
        // 1. Path exists (realpath canonicalizes: a symlink alias of a registered
        //    repo hits the SAME canonical key) and is a directory.
        let real: string;
        try {
          real = await realpath(input.path);
        } catch {
          return { ok: false, code: "invalid_path", message: `path does not exist: ${input.path}` };
        }
        let st;
        try {
          st = await stat(real);
        } catch {
          return { ok: false, code: "invalid_path", message: `path is not accessible: ${input.path}` };
        }
        if (!st.isDirectory()) {
          return { ok: false, code: "invalid_path", message: `not a directory: ${input.path}` };
        }

        // 2. Is a git repo (a `.git` dir OR file — worktrees/submodules use a file).
        if (!existsSync(join(real, ".git"))) {
          return { ok: false, code: "not_a_git_repo", message: `not a git repository (no .git): ${real}` };
        }

        // 3. Not already registered (canonical-path compare, win32 case-fold).
        const registry = await loadRegistry(deps.registryFile, deps.log);
        if (isPathRegistered(registry, real)) {
          return { ok: false, code: "already_registered", message: `path already registered: ${real}` };
        }

        // 4. Scaffold BEFORE the registry append: a failed scaffold must never
        //    leave a registered project pointing at a half-initialized repo.
        if (input.scaffold !== false) {
          const form = ScaffoldFormSchema.safeParse(input.config ?? {});
          if (!form.success) {
            const issues = form.error.issues
              .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
              .join("; ");
            return { ok: false, code: "invalid_config", message: `invalid config form: ${issues}` };
          }
          try {
            await scaffoldProject(real, form.data, deps.log);
          } catch (err) {
            if (err instanceof ScaffoldConfigError) {
              return { ok: false, code: "invalid_config", message: err.message };
            }
            throw err; // real fs failure -> route's top-level catch -> 500
          }
        }

        // 5. Registry append + save (inside the same lock as the load above).
        const { registry: updated, entry } = addProject(registry, {
          path: real,
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        await saveRegistry(deps.registryFile, updated);
        deps.log?.("INFO", `admin: registered project '${entry.id}' at ${entry.path}`);
        return { ok: true, entry };
      });
    },

    unregister(id) {
      return withLock(async () => {
        const registry = await loadRegistry(deps.registryFile, deps.log);
        if (!registry.projects.some((p) => p.id === id)) return false;
        await saveRegistry(deps.registryFile, removeProject(registry, id));
        deps.log?.("INFO", `admin: unregistered project '${id}' (registry entry only, folder untouched)`);
        return true;
      });
    },

    rename(id, name) {
      // Same read-modify-write mutex as `unregister`: the registry is a single JSON
      // file with plain-overwrite saves, so a concurrent rename must be serialized.
      // Renames only the display `name` — id (and its id-keyed hub/watcher caches)
      // and path stay valid.
      return withLock(async (): Promise<RenameResult> => {
        // 1. Validate the display name (policy lives here, not in the pure fn).
        const trimmed = name.trim();
        if (trimmed === "") {
          return { ok: false, code: "invalid_name", message: "name must not be empty" };
        }
        if (trimmed.length > 200) {
          return { ok: false, code: "invalid_name", message: "name must be at most 200 characters" };
        }

        // 2. Apply the pure rename; an unknown id -> not_found, without saving.
        const registry = await loadRegistry(deps.registryFile, deps.log);
        const result = renameProject(registry, id, trimmed);
        if (result === null) {
          return { ok: false, code: "not_found", message: `project not found: ${id}` };
        }

        // 3. Persist (inside the same lock as the load above).
        await saveRegistry(deps.registryFile, result.registry);
        deps.log?.("INFO", `admin: renamed project '${id}' to ${JSON.stringify(trimmed)}`);
        return { ok: true, entry: result.entry };
      });
    },

    async isRegistered(absPath) {
      const registry = await loadRegistry(deps.registryFile, deps.log);
      // Canonicalize the same way `register` does before storing (realpath), so a
      // membership check by an 8.3-aliased / symlinked / un-normalized path still
      // matches the stored canonical path. realpath fails for a non-existent path
      // (e.g. a folder-browser entry deleted since listing) -> fall back to the raw
      // path (isPathRegistered still `resolve`s + case-folds it).
      let canonical = absPath;
      try {
        canonical = await realpath(absPath);
      } catch {
        /* non-existent / inaccessible: compare the raw path */
      }
      return isPathRegistered(registry, canonical);
    },
  };
}
