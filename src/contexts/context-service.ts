import { dirname } from "node:path";

import { isCollection } from "yaml";

import {
  acquirePcwConfigMutationLock,
  commitPcwConfigMutation,
  type CreatedArtifact,
  pathExists,
  PcwConfigLockError,
  PcwConfigStaleError,
  type PcwConfigMutationSnapshot,
  readPcwConfigMutationSnapshot,
  rollbackCreatedArtifacts,
  serializePcwConfigMutation
} from "../config/config-mutation.js";
import {
  findSharedContext,
  findWorkstream,
  getWorkstreams,
  PcwConfigError
} from "../config/pcw-config.js";
import {
  assertExistingPathInsideBase,
  ensureDirectoryInsideBase,
  PcwPathError,
  resolveConfiguredPath
} from "../filesystem/paths.js";
import type {
  CreateSharedContextInput,
  CreateSharedContextResult,
  EnableWorkstreamContextInput,
  EnableWorkstreamContextResult
} from "./context-types.js";

const CREATED_CONTEXT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CREATED_CONTEXT_NAME_RULE =
  "Use 1 to 64 ASCII letters, digits, hyphens, or underscores, starting with a letter or digit.";

export type ContextCreationDependencies = {
  beforeConfigCommit?: () => Promise<void>;
  createContextDirectory?: (path: string) => Promise<void>;
  writeConfigAtomic?: (path: string, content: string) => Promise<void>;
  writeConfigBackup?: (path: string, content: string) => Promise<void>;
};

export class SharedContextNameInvalidError extends Error {
  readonly rule = CREATED_CONTEXT_NAME_RULE;

  constructor(readonly requestedName: string) {
    super(`Shared-context name '${requestedName}' is not valid for automatic creation`);
    this.name = "SharedContextNameInvalidError";
  }
}

export class SharedContextAlreadyExistsError extends Error {
  constructor(
    readonly requestedName: string,
    readonly existingContext: string
  ) {
    super(`Shared context '${existingContext}' already exists`);
    this.name = "SharedContextAlreadyExistsError";
  }
}

export class WorkstreamContextAlreadyConfiguredError extends Error {
  constructor(
    readonly workstream: string,
    readonly contextPath: string | null
  ) {
    super(`Workstream '${workstream}' already has specialized context configured`);
    this.name = "WorkstreamContextAlreadyConfiguredError";
  }
}

export class ContextWorkstreamNotFoundError extends Error {
  constructor(
    readonly requestedWorkstream: string,
    readonly availableWorkstreams: string[]
  ) {
    super(`Workstream '${requestedWorkstream}' is not defined`);
    this.name = "ContextWorkstreamNotFoundError";
  }
}

export class ContextCreateConflictError extends Error {
  constructor(
    readonly requestedName: string,
    message: string,
    readonly path: string | null = null,
    readonly rollbackFailures: string[] = [],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ContextCreateConflictError";
  }
}

function useBlockStyle(
  document: PcwConfigMutationSnapshot["document"],
  paths: Array<Array<string>>
): void {
  for (const path of paths) {
    const node = document.getIn(path, true);
    if (isCollection(node)) {
      node.flow = false;
    }
  }
}

async function acquireContextLock(
  contextRoot: string,
  requestedName: string
): Promise<() => Promise<void>> {
  try {
    return await acquirePcwConfigMutationLock(contextRoot);
  } catch (error) {
    if (error instanceof PcwConfigLockError) {
      throw new ContextCreateConflictError(requestedName, error.message);
    }
    throw error;
  }
}

async function createGeneratedDirectory(
  contextRoot: string,
  absolutePath: string,
  publicPath: string,
  requestedName: string,
  artifacts: CreatedArtifact[],
  dependencies: ContextCreationDependencies
): Promise<void> {
  if (await pathExists(absolutePath)) {
    throw new ContextCreateConflictError(
      requestedName,
      `Automatic context target already exists: '${publicPath}'`,
      publicPath
    );
  }

  const parent = dirname(absolutePath);
  if (await ensureDirectoryInsideBase(contextRoot, parent)) {
    artifacts.push({ path: parent, type: "directory" });
  }

  const createContextDirectory = dependencies.createContextDirectory ??
    ((path: string) =>
      ensureDirectoryInsideBase(contextRoot, path).then(() => undefined));
  await createContextDirectory(absolutePath);
  artifacts.push({ path: absolutePath, type: "directory" });
  await assertExistingPathInsideBase(contextRoot, absolutePath);
}

function rethrowContextError(
  error: unknown,
  requestedName: string,
  rollbackFailures: string[]
): never {
  if (rollbackFailures.length > 0) {
    throw new ContextCreateConflictError(
      requestedName,
      "Context creation failed and rollback was incomplete",
      null,
      rollbackFailures,
      { cause: error }
    );
  }

  if (
    error instanceof SharedContextNameInvalidError ||
    error instanceof SharedContextAlreadyExistsError ||
    error instanceof WorkstreamContextAlreadyConfiguredError ||
    error instanceof ContextWorkstreamNotFoundError ||
    error instanceof ContextCreateConflictError ||
    error instanceof PcwConfigStaleError ||
    error instanceof PcwConfigError ||
    error instanceof PcwPathError
  ) {
    throw error;
  }

  throw new ContextCreateConflictError(
    requestedName,
    "Could not create the context safely",
    null,
    [],
    { cause: error }
  );
}

export async function createSharedContext(
  contextRoot: string,
  input: CreateSharedContextInput,
  dependencies: ContextCreationDependencies = {}
): Promise<CreateSharedContextResult> {
  if (!CREATED_CONTEXT_NAME_PATTERN.test(input.name)) {
    throw new SharedContextNameInvalidError(input.name);
  }

  const releaseLock = await acquireContextLock(contextRoot, input.name);
  const artifacts: CreatedArtifact[] = [];
  let operationCompleted = false;

  try {
    const snapshot = await readPcwConfigMutationSnapshot(contextRoot);
    const duplicate = findSharedContext(snapshot.config, input.name);
    if (duplicate) {
      throw new SharedContextAlreadyExistsError(input.name, duplicate.name);
    }

    const contextPath = `shared/${input.name}`;
    const absolutePath = resolveConfiguredPath(contextRoot, contextPath);
    snapshot.document.setIn(
      ["shared_context", input.name],
      { path: contextPath }
    );
    useBlockStyle(snapshot.document, [
      ["shared_context"],
      ["shared_context", input.name]
    ]);
    const updatedConfig = serializePcwConfigMutation(snapshot);

    await createGeneratedDirectory(
      contextRoot,
      absolutePath,
      contextPath,
      input.name,
      artifacts,
      dependencies
    );
    const configBackupPath = await commitPcwConfigMutation(
      contextRoot,
      snapshot,
      updatedConfig,
      "Retry create_shared_context against the current pcw.yml.",
      artifacts,
      dependencies
    );
    operationCompleted = true;

    return {
      name: input.name,
      path: contextPath,
      configBackupPath,
      created: true
    };
  } catch (error) {
    return rethrowContextError(
      error,
      input.name,
      await rollbackCreatedArtifacts(artifacts)
    );
  } finally {
    try {
      await releaseLock();
    } catch (error) {
      if (!operationCompleted) {
        throw error;
      }
    }
  }
}

export async function enableWorkstreamContext(
  contextRoot: string,
  input: EnableWorkstreamContextInput,
  dependencies: ContextCreationDependencies = {}
): Promise<EnableWorkstreamContextResult> {
  const releaseLock = await acquireContextLock(contextRoot, input.name);
  const artifacts: CreatedArtifact[] = [];
  let operationCompleted = false;

  try {
    const snapshot = await readPcwConfigMutationSnapshot(contextRoot);
    const resolved = findWorkstream(snapshot.config, input.name);
    if (!resolved) {
      throw new ContextWorkstreamNotFoundError(
        input.name,
        Object.keys(getWorkstreams(snapshot.config))
      );
    }
    if (resolved.config.context?.path) {
      throw new WorkstreamContextAlreadyConfiguredError(
        resolved.name,
        resolved.config.context.path
      );
    }
    if (!CREATED_CONTEXT_NAME_PATTERN.test(resolved.name)) {
      throw new ContextCreateConflictError(
        input.name,
        "The configured workstream name cannot be used for an automatic context path"
      );
    }

    const contextPath = `workstreams/${resolved.name}`;
    const absolutePath = resolveConfiguredPath(contextRoot, contextPath);
    snapshot.document.setIn(
      ["workstreams", resolved.name, "context"],
      { path: contextPath }
    );
    useBlockStyle(snapshot.document, [
      ["workstreams"],
      ["workstreams", resolved.name],
      ["workstreams", resolved.name, "context"]
    ]);
    const updatedConfig = serializePcwConfigMutation(snapshot);

    await createGeneratedDirectory(
      contextRoot,
      absolutePath,
      contextPath,
      input.name,
      artifacts,
      dependencies
    );
    const configBackupPath = await commitPcwConfigMutation(
      contextRoot,
      snapshot,
      updatedConfig,
      "Retry enable_workstream_context against the current pcw.yml.",
      artifacts,
      dependencies
    );
    operationCompleted = true;

    return {
      workstream: resolved.name,
      contextPath,
      configBackupPath,
      created: true
    };
  } catch (error) {
    return rethrowContextError(
      error,
      input.name,
      await rollbackCreatedArtifacts(artifacts)
    );
  } finally {
    try {
      await releaseLock();
    } catch (error) {
      if (!operationCompleted) {
        throw error;
      }
    }
  }
}
