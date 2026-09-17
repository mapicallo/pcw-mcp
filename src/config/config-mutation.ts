import { lstat, open, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import writeFileAtomic from "write-file-atomic";
import { parseDocument } from "yaml";

import type { PcwConfig } from "../domain/pcw-types.js";
import { sha256Text } from "../filesystem/hashing.js";
import {
  assertExistingPathInsideBase,
  ensureDirectoryInsideBase,
  ensureInsideBase,
  resolveConfiguredPath
} from "../filesystem/paths.js";
import { PcwConfigError } from "./pcw-config.js";
import { pcwConfigSchema } from "./pcw-schema.js";

export type CreatedArtifact = {
  path: string;
  type: "file" | "directory";
};

export type PcwConfigMutationSnapshot = {
  configPath: string;
  originalContent: string;
  originalSha256: string;
  document: ReturnType<typeof parseDocument>;
  config: PcwConfig;
};

export type PcwConfigCommitDependencies = {
  beforeConfigCommit?: () => Promise<void>;
  writeConfigAtomic?: (path: string, content: string) => Promise<void>;
  writeConfigBackup?: (path: string, content: string) => Promise<void>;
};

export class PcwConfigLockError extends Error {
  constructor() {
    super("Another PCW configuration write is already in progress");
    this.name = "PcwConfigLockError";
  }
}

export class PcwConfigStaleError extends Error {
  constructor(
    readonly expectedSha256: string,
    readonly currentSha256: string,
    readonly action: string,
    message = "pcw.yml changed while the structural operation was being prepared"
  ) {
    super(message);
    this.name = "PcwConfigStaleError";
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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

export async function readPcwConfigMutationSnapshot(
  contextRoot: string
): Promise<PcwConfigMutationSnapshot> {
  const configPath = resolveConfiguredPath(contextRoot, "pcw.yml");
  await assertExistingPathInsideBase(contextRoot, configPath);
  const originalContent = await readFile(configPath, "utf8");
  const { document, config } = validateConfigDocument(
    originalContent,
    configPath
  );

  return {
    configPath,
    originalContent,
    originalSha256: sha256Text(originalContent),
    document,
    config
  };
}

export function serializePcwConfigMutation(
  snapshot: PcwConfigMutationSnapshot
): string {
  const content = snapshot.document.toString({ lineWidth: 0 });
  validateConfigDocument(content, snapshot.configPath);
  return content;
}

export async function acquirePcwConfigMutationLock(
  contextRoot: string
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
      throw new PcwConfigLockError();
    }
    throw error;
  }

  return async () => {
    await handle.close();
    await rm(lockPath, { force: true });
  };
}

export async function commitPcwConfigMutation(
  contextRoot: string,
  snapshot: PcwConfigMutationSnapshot,
  updatedContent: string,
  action: string,
  createdArtifacts: CreatedArtifact[],
  dependencies: PcwConfigCommitDependencies = {},
  staleMessage?: string
): Promise<string> {
  await dependencies.beforeConfigCommit?.();

  const currentContent = await readFile(snapshot.configPath, "utf8");
  const currentSha256 = sha256Text(currentContent);
  if (currentSha256 !== snapshot.originalSha256) {
    throw new PcwConfigStaleError(
      snapshot.originalSha256,
      currentSha256,
      action,
      staleMessage
    );
  }

  const historyDirectory = resolveConfiguredPath(
    contextRoot,
    ".pcw/history/config"
  );
  await ensureDirectoryInsideBase(contextRoot, historyDirectory);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const configBackupPath =
    `.pcw/history/config/${timestamp}-${snapshot.originalSha256.slice(0, 12)}.yml`;
  const backupAbsolutePath = resolveConfiguredPath(
    contextRoot,
    configBackupPath
  );
  const writeConfigBackup = dependencies.writeConfigBackup ??
    ((path: string, content: string) =>
      writeFile(path, content, { encoding: "utf8", flag: "wx" }));
  const writeConfigAtomic = dependencies.writeConfigAtomic ??
    ((path: string, content: string) =>
      writeFileAtomic(path, content, { encoding: "utf8" }));

  await writeConfigBackup(backupAbsolutePath, snapshot.originalContent);
  createdArtifacts.push({ path: backupAbsolutePath, type: "file" });
  await assertExistingPathInsideBase(contextRoot, backupAbsolutePath);
  await writeConfigAtomic(snapshot.configPath, updatedContent);
  return configBackupPath;
}

export async function pathExists(path: string): Promise<boolean> {
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

export async function rollbackCreatedArtifacts(
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
