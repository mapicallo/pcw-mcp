import { randomBytes } from "node:crypto";
import {
  lstat,
  link,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  mkdir
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep
} from "node:path";

import { Document } from "yaml";

import { getWorkstreams, loadPcwConfig } from "../config/pcw-config.js";
import { pcwConfigSchema } from "../config/pcw-schema.js";

export type ContextInitializationStatus = "initialized" | "already-initialized";

export interface InitializeContextRootOptions {
  contextRoot: string;
  protectedPaths?: string[];
}

export interface InitializeContextRootResult {
  status: ContextInitializationStatus;
  contextRoot: string;
  configPath: string;
  workstreamCount: number;
  createdDirectory: boolean;
}

export type ContextInitializationErrorCode =
  | "PCW_CONTEXT_INITIALIZATION_UNSAFE"
  | "PCW_CONTEXT_NOT_EMPTY"
  | "PCW_CONTEXT_CONFIG_INVALID"
  | "PCW_CONTEXT_INITIALIZATION_CONFLICT";

export class ContextInitializationError extends Error {
  constructor(
    readonly code: ContextInitializationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ContextInitializationError";
  }
}

export interface ContextInitializationDependencies {
  beforePublish?: () => Promise<void>;
  publishConfig?: (temporaryPath: string, configPath: string) => Promise<void>;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isSameOrInside(basePath: string, candidatePath: string): boolean {
  const path = relative(resolve(basePath), resolve(candidatePath));
  return path === "" || (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function validateRequestedPath(contextRoot: string, protectedPaths: string[]): string {
  if (!isAbsolute(contextRoot)) {
    throw new ContextInitializationError(
      "PCW_CONTEXT_INITIALIZATION_UNSAFE",
      "PCW context root must be an absolute path"
    );
  }
  if (contextRoot.split(/[\\/]+/u).includes("..")) {
    throw new ContextInitializationError(
      "PCW_CONTEXT_INITIALIZATION_UNSAFE",
      "PCW context root must not contain parent traversal segments"
    );
  }
  const target = resolve(contextRoot);
  if (target === parsePath(target).root) {
    throw new ContextInitializationError(
      "PCW_CONTEXT_INITIALIZATION_UNSAFE",
      "A filesystem root cannot be initialized as a PCW context"
    );
  }
  for (const protectedPath of protectedPaths) {
    const protectedRoot = resolve(protectedPath);
    if (isSameOrInside(protectedRoot, target) || isSameOrInside(target, protectedRoot)) {
      throw new ContextInitializationError(
        "PCW_CONTEXT_INITIALIZATION_UNSAFE",
        "PCW context root must not overlap a protected runtime or installer path"
      );
    }
  }
  return target;
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ContextInitializationError(
      "PCW_CONTEXT_INITIALIZATION_UNSAFE",
      `${label} must be a regular local directory`
    );
  }
  const actual = await realpath(path);
  if (relative(resolve(path), actual) !== "") {
    throw new ContextInitializationError(
      "PCW_CONTEXT_INITIALIZATION_UNSAFE",
      `${label} must not resolve through a symbolic link or reparse point`
    );
  }
}

function createMinimalConfig(): string {
  const value = {
    version: 1,
    workstreams: {}
  };
  pcwConfigSchema.parse(value);
  return new Document(value).toString({ lineWidth: 0 });
}

async function existingInitialization(
  contextRoot: string,
  configPath: string
): Promise<InitializeContextRootResult> {
  const configInfo = await lstat(configPath);
  if (configInfo.isSymbolicLink() || !configInfo.isFile()) {
    throw new ContextInitializationError(
      "PCW_CONTEXT_CONFIG_INVALID",
      "Existing pcw.yml is not a regular local file"
    );
  }
  try {
    const { config } = await loadPcwConfig(contextRoot);
    return {
      status: "already-initialized",
      contextRoot,
      configPath,
      workstreamCount: Object.keys(getWorkstreams(config)).length,
      createdDirectory: false
    };
  } catch (cause) {
    throw new ContextInitializationError(
      "PCW_CONTEXT_CONFIG_INVALID",
      "Existing pcw.yml is invalid and will not be overwritten",
      { cause }
    );
  }
}

async function cleanupCreatedDirectory(contextRoot: string): Promise<void> {
  try {
    if ((await readdir(contextRoot)).length === 0) await rmdir(contextRoot);
  } catch {
    // Preserve anything created concurrently; initialization never removes recursively.
  }
}

export async function initializeContextRoot(
  options: InitializeContextRootOptions,
  dependencies: ContextInitializationDependencies = {}
): Promise<InitializeContextRootResult> {
  const contextRoot = validateRequestedPath(
    options.contextRoot,
    options.protectedPaths ?? []
  );
  const parent = dirname(contextRoot);
  try {
    await assertPlainDirectory(parent, "PCW context parent");
  } catch (cause) {
    if (cause instanceof ContextInitializationError) throw cause;
    throw new ContextInitializationError(
      "PCW_CONTEXT_INITIALIZATION_UNSAFE",
      "PCW context parent must already exist as a regular local directory",
      { cause }
    );
  }

  let createdDirectory = false;
  try {
    await assertPlainDirectory(contextRoot, "PCW context root");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    try {
      await mkdir(contextRoot);
      createdDirectory = true;
    } catch (cause) {
      if (!isNodeError(cause, "EEXIST")) {
        throw new ContextInitializationError(
          "PCW_CONTEXT_INITIALIZATION_CONFLICT",
          "Could not create the PCW context directory",
          { cause }
        );
      }
    }
    await assertPlainDirectory(contextRoot, "PCW context root");
  }

  const configPath = join(contextRoot, "pcw.yml");
  try {
    try {
      return await existingInitialization(contextRoot, configPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    const entries = await readdir(contextRoot);
    if (entries.length > 0) {
      throw new ContextInitializationError(
        "PCW_CONTEXT_NOT_EMPTY",
        "PCW context root must be empty when pcw.yml does not exist"
      );
    }

    const content = createMinimalConfig();
    const temporaryPath = join(
      contextRoot,
      `.pcw.yml.initializing-${process.pid}-${randomBytes(8).toString("hex")}`
    );
    let temporaryCreated = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await dependencies.beforePublish?.();
      const concurrentEntries = (await readdir(contextRoot)).filter(
        (entry) => entry !== temporaryPath.slice(contextRoot.length + 1)
      );
      if (concurrentEntries.length > 0) {
        throw new ContextInitializationError(
          "PCW_CONTEXT_INITIALIZATION_CONFLICT",
          "PCW context root changed while initialization was in progress"
        );
      }
      await (dependencies.publishConfig ?? link)(temporaryPath, configPath);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        return await existingInitialization(contextRoot, configPath);
      }
      throw error;
    } finally {
      if (temporaryCreated) await rm(temporaryPath, { force: true });
    }

    try {
      const { config } = await loadPcwConfig(contextRoot);
      return {
        status: "initialized",
        contextRoot,
        configPath,
        workstreamCount: Object.keys(getWorkstreams(config)).length,
        createdDirectory
      };
    } catch (cause) {
      try {
        if (await readFile(configPath, "utf8") === content) {
          await rm(configPath, { force: true });
        }
      } catch {
        // Preserve an unknown concurrent state instead of deleting it.
      }
      throw new ContextInitializationError(
        "PCW_CONTEXT_INITIALIZATION_CONFLICT",
        "Created pcw.yml did not pass normal PCW validation",
        { cause }
      );
    }
  } catch (error) {
    if (createdDirectory) await cleanupCreatedDirectory(contextRoot);
    if (error instanceof ContextInitializationError) throw error;
    throw new ContextInitializationError(
      "PCW_CONTEXT_INITIALIZATION_CONFLICT",
      "Could not initialize the PCW context safely",
      { cause: error }
    );
  }
}
