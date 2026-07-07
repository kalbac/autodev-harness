/**
 * Project admin for the New Project flow (spec §5/§6): register (validate →
 * scaffold → registry append), unregister (registry entry ONLY — never touches
 * the project folder), and the registry-membership check the folder browser
 * annotates with. Every registry read-modify-write runs through a promise-chain
 * mutex: the registry is a single JSON file with plain-overwrite saves, so two
 * concurrent POST /projects handled without serialization would race
 * (last-writer-wins) and silently lose one entry.
 */
import { stat, realpath, lstat, readFile, writeFile, mkdir } from "node:fs/promises";
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
import { scaffoldProject, mergeConfigYaml, ScaffoldConfigError, ScaffoldFormSchema } from "./scaffold.js";
import { createGit } from "../util/git.js";
import { ensureAutodevBranch, initAutodevRepo } from "../util/ensure-branch.js";

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

export type ConfigUpdateErrorCode = "not_found" | "invalid_config";

export type ConfigUpdateResult = { ok: true } | { ok: false; code: ConfigUpdateErrorCode; message: string };

export type GitInitErrorCode = "invalid_path" | "already_git_repo" | "git_unavailable";

export type GitInitResult =
  | { ok: true; branch: string; untrackedCount: number }
  | { ok: false; code: GitInitErrorCode; message: string };

/** Injectable git bootstrap ops (default: real, via `createGit`). Tests override
 *  so registry unit tests never shell out to git on a fake `.git` dir. */
export interface AdminGitOps {
  ensureAutodevBranch(repoRoot: string): Promise<{ branch: string; switched: boolean }>;
  initAutodevRepo(repoRoot: string): Promise<{ branch: string; untrackedCount: number }>;
}

export interface ProjectAdmin {
  register(input: RegisterInput): Promise<RegisterResult>;
  /** True when removed; false for an unknown id. Registry entry only. */
  unregister(id: string): Promise<boolean>;
  /** Set a project's display name by id. Registry entry only — never touches the folder. */
  rename(id: string, name: string): Promise<RenameResult>;
  /** Merge `form` into the project's `.autodev/config.yaml` (creating the file
   *  from an empty base if absent) and write it back. This writes the PROJECT'S
   *  file, not registry.json, but is still serialized through the same lock so
   *  it can't race a concurrent register/rename/unregister. Does NOT invalidate
   *  any hub-cached ProjectRoot — that's the caller's job (index.ts wires
   *  eviction), keeping this module hub-agnostic (mirrors how DELETE's watcher
   *  teardown lives in server.ts, not here). */
  updateConfig(id: string, rawForm: unknown): Promise<ConfigUpdateResult>;
  /** Registry membership by canonical path (folder-browser badge). */
  isRegistered(absPath: string): Promise<boolean>;
  /** Turn a NON-git folder into a git repo on an `^autodev/` branch (empty
   *  bootstrap commit; existing files stay untracked). Rejects a path already
   *  under git. Registry-independent (does NOT register). */
  initGit(path: string): Promise<GitInitResult>;
}

export function createProjectAdmin(deps: { registryFile: string; log?: Log; gitOps?: AdminGitOps }): ProjectAdmin {
  const gitOps: AdminGitOps = deps.gitOps ?? {
    ensureAutodevBranch: (root) => ensureAutodevBranch(createGit(root), { log: deps.log }),
    initAutodevRepo: (root) => initAutodevRepo(createGit(root), { log: deps.log }),
  };
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

        // 2. Not already registered (canonical-path compare, win32 case-fold).
        const registry = await loadRegistry(deps.registryFile, deps.log);
        if (isPathRegistered(registry, real)) {
          return { ok: false, code: "already_registered", message: `path already registered: ${real}` };
        }

        // 3. Scaffold BEFORE the registry append: a failed scaffold must never
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

        // Put an existing git repo on an `^autodev/` branch so its first run
        // clears the conductor guard (s30 Task 1). A non-git folder registers
        // as-is (it can't run until `initGit`); we only ensure-branch when a
        // repo is present. Best-effort must NOT block registration — log + carry on.
        if (existsSync(join(real, ".git"))) {
          try {
            await gitOps.ensureAutodevBranch(real);
          } catch (err) {
            deps.log?.("WARN", `admin: ensure-branch failed for ${real}: ${String(err)}`);
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

    initGit(path) {
      return withLock(async (): Promise<GitInitResult> => {
        let real: string;
        try {
          real = await realpath(path);
        } catch {
          return { ok: false, code: "invalid_path", message: `path does not exist: ${path}` };
        }
        let st;
        try {
          st = await stat(real);
        } catch {
          return { ok: false, code: "invalid_path", message: `path is not accessible: ${path}` };
        }
        if (!st.isDirectory()) {
          return { ok: false, code: "invalid_path", message: `not a directory: ${path}` };
        }
        if (existsSync(join(real, ".git"))) {
          return { ok: false, code: "already_git_repo", message: `already a git repository: ${real}` };
        }
        try {
          const { branch, untrackedCount } = await gitOps.initAutodevRepo(real);
          deps.log?.("INFO", `admin: git-init ${real} -> ${branch} (${untrackedCount} untracked)`);
          return { ok: true, branch, untrackedCount };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { ok: false, code: "git_unavailable", message: "git is not installed or not on PATH" };
          }
          throw err; // real git/fs failure -> route's top-level catch -> 500
        }
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

    updateConfig(id, rawForm) {
      // Same read-modify-write mutex as register/unregister/rename: this writes
      // the PROJECT's config.yaml, not registry.json, but must still be
      // serialized so it can't race a concurrent register/rename/unregister.
      return withLock(async (): Promise<ConfigUpdateResult> => {
        // 1. Validate shape (same issue-join style register already uses).
        const form = ScaffoldFormSchema.safeParse(rawForm);
        if (!form.success) {
          const issues = form.error.issues
            .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
            .join("; ");
          return { ok: false, code: "invalid_config", message: `invalid config form: ${issues}` };
        }

        // 2. Resolve the entry by id.
        const registry = await loadRegistry(deps.registryFile, deps.log);
        const entry = registry.projects.find((p) => p.id === id);
        if (!entry) {
          return { ok: false, code: "not_found", message: `project not found: ${id}` };
        }

        // 3. Symlink guard (same class as `[scaffold/symlink-escape]` — writeFile/
        //    mkdir follow symlinks, so a hostile `.autodev -> /outside` would write
        //    outside the repo). A missing `.autodev` is fine; step 6 creates it.
        const autodevDir = join(entry.path, ".autodev");
        let autodevLst;
        try {
          autodevLst = await lstat(autodevDir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (autodevLst !== undefined && !autodevLst.isDirectory()) {
          return {
            ok: false,
            code: "invalid_config",
            message: "refusing to write config: .autodev is not a real directory (symlink?)",
          };
        }

        // 4. Read the existing config text. Missing -> "" (mirrors loadConfig's own
        //    missing-file convention -- merge starts from {}). Any OTHER read error
        //    bubbles up to the route's top-level 500 catch (same as register's
        //    real-fs-failure precedent). Same symlink-escape guard as `.autodev`
        //    itself: `.autodev` can be a real directory while `config.yaml` INSIDE
        //    it is a symlink to an outside file -- readFile/writeFile would follow
        //    it transparently, so lstat it first and refuse anything but a real file.
        const configPath = join(autodevDir, "config.yaml");
        let configLst;
        try {
          configLst = await lstat(configPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (configLst !== undefined && !configLst.isFile()) {
          return {
            ok: false,
            code: "invalid_config",
            message: "refusing to write config: config.yaml is not a real file (symlink?)",
          };
        }
        let existingText = "";
        try {
          existingText = await readFile(configPath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }

        // 5. Merge + validate BEFORE any write.
        let mergedText: string;
        try {
          mergedText = mergeConfigYaml(existingText, form.data);
        } catch (err) {
          if (err instanceof ScaffoldConfigError) {
            return { ok: false, code: "invalid_config", message: err.message };
          }
          throw err;
        }

        // 6. Write back (plain overwrite -- single-writer, small file. Project file
        //    only; registry.json is untouched).
        await mkdir(autodevDir, { recursive: true });
        await writeFile(configPath, mergedText, "utf8");
        deps.log?.("INFO", `admin: updated config for project '${id}'`);
        return { ok: true };
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
