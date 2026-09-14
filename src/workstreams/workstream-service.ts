import {
  lstat,
  open,
  readFile,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";

import writeFileAtomic from "write-file-atomic";
import { isCollection, parseDocument } from "yaml";

import {
  PcwConfigError,
  findWorkstream
} from "../config/pcw-config.js";
import { pcwConfigSchema } from "../config/pcw-schema.js";
import { sha256Text } from "../filesystem/hashing.js";
import {
  assertExistingPathInsideBase,
  ensureDirectoryInsideBase,
  ensureInsideBase,
  PcwPathError,
  resolveConfiguredPath
} from "../filesystem/paths.js";
import type {
  CreateWorkstreamInput,
  CreateWorkstreamResult,
  WorkstreamCreationMode
} from "./workstream-types.js";

const WORKSTREAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORKSTREAM_NAME_RULE =
  "Use 1 to 64 ASCII letters, digits, hyphens, or underscores, starting with a letter or digit.";

type CreatedArtifact = {
  path: string;
  type: "file" | "directory";
};

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

export class PcwConfigStaleError extends Error {
  constructor(
    readonly expectedSha256: string,
    readonly currentSha256: string
  ) {
    super("pcw.yml changed while the workstream was being created");
    this.name = "PcwConfigStaleError";
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === code;
}

function validateWorkstreamName(name: string): void {
  if (!WORKSTREAM_NAME_PATTERN.test(name)) {
    throw new WorkstreamNameInvalidError(name);
  }
}

function validateConfigDocument(content: string, configPath: string) {
  const document = parseDocument(content);

  if (document.errors.length > 0) {
    throw new PcwConfigError(
      `Could not parse PCW configuration at '${configPath}'`,
      { cause: document.errors[0] }
    );
  }

  const result = pcwConfigSchema.safeParse(document.toJS());
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 3)
      .map((issue) => {
        const location = issue.path.length > 0
          ? issue.path.join(".")
          : "configuration";
        return `${location}: ${issue.message}`;
      })
      .join("; ");

    throw new PcwConfigError(
      `Invalid PCW configuration at '${configPath}': ${details}`
    );
  }

  return { document, config: result.data };
}

function useBlockStyleForCreatedWorkstream(
  document: ReturnType<typeof parseDocument>,
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
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

async function acquireConfigLock(
  contextRoot: string,
  requestedName: string
): Promise<() => Promise<void>> {
  const lockDirectory = resolveConfiguredPath(contextRoot, ".pcw/locks");
  await ensureDirectoryInsideBase(contextRoot, lockDirectory);

  const lockPath = ensureInsideBase(
    lockDirectory,
    join(lockDirectory, "pcw-config.lock")
  );

  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new WorkstreamCreateConflictError(
        requestedName,
        "Another PCW configuration write is already in progress"
      );
    }
    throw error;
  }

  return async () => {
    await handle.close();
    await rm(lockPath, { force: true });
  };
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

async function rollbackArtifacts(
  artifacts: CreatedArtifact[]
): Promise<string[]> {
  const failures: string[] = [];

  for (const artifact of [...artifacts].reverse()) {
    try {
      if (artifact.type === "file") {
        await rm(artifact.path, { force: true });
      } else {
        await rmdir(artifact.path);
      }
    } catch (error) {
      failures.push(
        `${artifact.path}: ${error instanceof Error ? error.message : "rollback failed"}`
      );
    }
  }

  return failures;
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
  const configPath = resolveConfiguredPath(contextRoot, "pcw.yml");
  await assertExistingPathInsideBase(contextRoot, configPath);

  const releaseLock = await acquireConfigLock(contextRoot, input.name);
  const createdArtifacts: CreatedArtifact[] = [];
  let operationCompleted = false;

  const writeContinuityFile = dependencies.writeContinuityFile ??
    ((path: string, content: string) =>
      writeFile(path, content, { encoding: "utf8", flag: "wx" }));
  const createContextDirectory = dependencies.createContextDirectory ??
    ((path: string) => ensureDirectoryInsideBase(contextRoot, path).then(() => undefined));
  const writeConfigBackup = dependencies.writeConfigBackup ??
    ((path: string, content: string) =>
      writeFile(path, content, { encoding: "utf8", flag: "wx" }));
  const writeConfigAtomic = dependencies.writeConfigAtomic ??
    ((path: string, content: string) =>
      writeFileAtomic(path, content, { encoding: "utf8" }));

  try {
    const originalConfig = await readFile(configPath, "utf8");
    const originalConfigSha256 = sha256Text(originalConfig);
    const { document, config } = validateConfigDocument(
      originalConfig,
      configPath
    );
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
    const updatedConfig = document.toString({ lineWidth: 0 });
    validateConfigDocument(updatedConfig, configPath);

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

    await dependencies.beforeConfigCommit?.();

    const currentConfig = await readFile(configPath, "utf8");
    const currentConfigSha256 = sha256Text(currentConfig);
    if (currentConfigSha256 !== originalConfigSha256) {
      throw new PcwConfigStaleError(
        originalConfigSha256,
        currentConfigSha256
      );
    }

    const configHistoryDirectory = resolveConfiguredPath(
      contextRoot,
      ".pcw/history/config"
    );
    await ensureDirectoryInsideBase(contextRoot, configHistoryDirectory);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const configBackupPath =
      `.pcw/history/config/${timestamp}-${originalConfigSha256.slice(0, 12)}.yml`;
    const configBackupAbsolutePath = resolveConfiguredPath(
      contextRoot,
      configBackupPath
    );

    await writeConfigBackup(configBackupAbsolutePath, originalConfig);
    createdArtifacts.push({
      path: configBackupAbsolutePath,
      type: "file"
    });
    await assertExistingPathInsideBase(contextRoot, configBackupAbsolutePath);

    await writeConfigAtomic(configPath, updatedConfig);
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
    const rollbackFailures = await rollbackArtifacts(createdArtifacts);

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
