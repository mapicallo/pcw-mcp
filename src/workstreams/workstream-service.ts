import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isCollection } from "yaml";

import {
  PcwConfigError,
  findWorkstream
} from "../config/pcw-config.js";
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
import { sha256Text } from "../filesystem/hashing.js";
import {
  assertExistingPathInsideBase,
  ensureDirectoryInsideBase,
  PcwPathError,
  resolveConfiguredPath
} from "../filesystem/paths.js";
import type {
  CreateWorkstreamInput,
  CreateWorkstreamResult,
  WorkstreamCreationMode
} from "./workstream-types.js";

export { PcwConfigStaleError };

const WORKSTREAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORKSTREAM_NAME_RULE =
  "Use 1 to 64 ASCII letters, digits, hyphens, or underscores, starting with a letter or digit.";

export type WorkstreamCreationDependencies = {
  beforeConfigCommit?: () => Promise<void>;
  createContextDirectory?: (path: string) => Promise<void>;
  writeConfigAtomic?: (path: string, content: string) => Promise<void>;
  writeConfigBackup?: (path: string, content: string) => Promise<void>;
  writeContinuityFile?: (path: string, content: string) => Promise<void>;
};

export class WorkstreamNameInvalidError extends Error {
  readonly rule = WORKSTREAM_NAME_RULE;

  constructor(readonly requestedName: string) {
    super(`Workstream name '${requestedName}' is not valid for automatic creation`);
    this.name = "WorkstreamNameInvalidError";
  }
}

export class WorkstreamAlreadyExistsError extends Error {
  constructor(
    readonly requestedName: string,
    readonly existingWorkstream: string
  ) {
    super(`Workstream '${existingWorkstream}' already exists`);
    this.name = "WorkstreamAlreadyExistsError";
  }
}

export class WorkstreamCreateConflictError extends Error {
  constructor(
    readonly requestedName: string,
    message: string,
    readonly path: string | null = null,
    readonly rollbackFailures: string[] = [],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkstreamCreateConflictError";
  }
}

function validateWorkstreamName(name: string): void {
  if (!WORKSTREAM_NAME_PATTERN.test(name)) {
    throw new WorkstreamNameInvalidError(name);
  }
}

function useBlockStyleForCreatedWorkstream(
  document: PcwConfigMutationSnapshot["document"],
  workstreamName: string
): void {
  for (const path of [
    ["workstreams"],
    ["workstreams", workstreamName],
    ["workstreams", workstreamName, "context"],
    ["workstreams", workstreamName, "continuity"]
  ]) {
    const node = document.getIn(path, true);
    if (isCollection(node)) {
      node.flow = false;
    }
  }
}

async function assertAvailableTarget(
  path: string,
  requestedName: string,
  publicPath: string
): Promise<void> {
  if (await pathExists(path)) {
    throw new WorkstreamCreateConflictError(
      requestedName,
      `Automatic workstream target already exists: '${publicPath}'`,
      publicPath
    );
  }
}

function createInitialContinuity(
  name: string,
  initialObjective?: string
): string {
  const objective = initialObjective?.trim() ||
    "Define the first durable objective for this workstream.";

  return `# ${name}

## Current objective

${objective}

## Current state

This workstream has been created and is ready for durable workstream state.

## Completed

- None recorded yet.

## Decisions

- None recorded yet.

## Avoid repeating

- None recorded yet.

## Open questions / blockers

- None recorded yet.

## Relevant sources

- None recorded yet.

## Next action

Establish or reconstruct the first durable workstream checkpoint.
`;
}

export async function createWorkstream(
  contextRoot: string,
  input: CreateWorkstreamInput,
  dependencies: WorkstreamCreationDependencies = {}
): Promise<CreateWorkstreamResult> {
  validateWorkstreamName(input.name);

  const mode: WorkstreamCreationMode = input.mode ?? "continuity-only";
  const continuityPath = `continuity/${input.name}.md`;
  const contextPath = mode === "with-context"
    ? `workstreams/${input.name}`
    : null;
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await acquirePcwConfigMutationLock(contextRoot);
  } catch (error) {
    if (error instanceof PcwConfigLockError) {
      throw new WorkstreamCreateConflictError(input.name, error.message);
    }
    throw error;
  }
  const createdArtifacts: CreatedArtifact[] = [];
  let operationCompleted = false;

  const writeContinuityFile = dependencies.writeContinuityFile ??
    ((path: string, content: string) =>
      writeFile(path, content, { encoding: "utf8", flag: "wx" }));
  const createContextDirectory = dependencies.createContextDirectory ??
    ((path: string) => ensureDirectoryInsideBase(contextRoot, path).then(() => undefined));
  try {
    const snapshot = await readPcwConfigMutationSnapshot(contextRoot);
    const { document, config } = snapshot;
    const duplicate = findWorkstream(config, input.name);
    if (duplicate) {
      throw new WorkstreamAlreadyExistsError(input.name, duplicate.name);
    }

    const continuityAbsolutePath = resolveConfiguredPath(
      contextRoot,
      continuityPath
    );
    const contextAbsolutePath = contextPath
      ? resolveConfiguredPath(contextRoot, contextPath)
      : null;

    await assertAvailableTarget(
      continuityAbsolutePath,
      input.name,
      continuityPath
    );
    if (contextAbsolutePath && contextPath) {
      await assertAvailableTarget(contextAbsolutePath, input.name, contextPath);
    }

    const workstreamConfig = contextPath
      ? {
          context: { path: contextPath },
          continuity: { path: continuityPath }
        }
      : {
          continuity: { path: continuityPath }
        };
    document.setIn(["workstreams", input.name], workstreamConfig);
    useBlockStyleForCreatedWorkstream(document, input.name);
    const updatedConfig = serializePcwConfigMutation(snapshot);

    const continuityDirectory = dirname(continuityAbsolutePath);
    if (await ensureDirectoryInsideBase(contextRoot, continuityDirectory)) {
      createdArtifacts.push({
        path: continuityDirectory,
        type: "directory"
      });
    }

    const initialContinuity = createInitialContinuity(
      input.name,
      input.initialObjective
    );
    await writeContinuityFile(continuityAbsolutePath, initialContinuity);
    createdArtifacts.push({
      path: continuityAbsolutePath,
      type: "file"
    });
    await assertExistingPathInsideBase(contextRoot, continuityAbsolutePath);

    if (contextAbsolutePath) {
      const contextParent = dirname(contextAbsolutePath);
      if (await ensureDirectoryInsideBase(contextRoot, contextParent)) {
        createdArtifacts.push({ path: contextParent, type: "directory" });
      }
      await createContextDirectory(contextAbsolutePath);
      createdArtifacts.push({ path: contextAbsolutePath, type: "directory" });
      await assertExistingPathInsideBase(contextRoot, contextAbsolutePath);
    }

    const configBackupPath = await commitPcwConfigMutation(
      contextRoot,
      snapshot,
      updatedConfig,
      "Retry create_workstream against the current pcw.yml.",
      createdArtifacts,
      dependencies,
      "pcw.yml changed while the workstream was being created"
    );
    operationCompleted = true;

    return {
      workstream: input.name,
      mode,
      continuityPath,
      contextPath,
      configBackupPath,
      created: true,
      initialContinuitySha256: sha256Text(initialContinuity)
    };
  } catch (error) {
    const rollbackFailures = await rollbackCreatedArtifacts(createdArtifacts);

    if (rollbackFailures.length > 0) {
      throw new WorkstreamCreateConflictError(
        input.name,
        "Workstream creation failed and rollback was incomplete",
        null,
        rollbackFailures,
        { cause: error }
      );
    }

    if (
      error instanceof WorkstreamNameInvalidError ||
      error instanceof WorkstreamAlreadyExistsError ||
      error instanceof WorkstreamCreateConflictError ||
      error instanceof PcwConfigStaleError ||
      error instanceof PcwConfigError ||
      error instanceof PcwPathError
    ) {
      throw error;
    }

    throw new WorkstreamCreateConflictError(
      input.name,
      "Could not create the workstream safely",
      null,
      [],
      { cause: error }
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
