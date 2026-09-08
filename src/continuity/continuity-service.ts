import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  stat
} from "node:fs/promises";
import { extname, join } from "node:path";

import writeFileAtomic from "write-file-atomic";

import {
  findWorkstream,
  getWorkstreams
} from "../config/pcw-config.js";
import type { PcwConfig } from "../domain/pcw-types.js";
import { sha256Text } from "../filesystem/hashing.js";
import {
  assertExistingPathInsideBase,
  assertExistingSourcePath,
  ensureInsideBase,
  resolveConfiguredPath
} from "../filesystem/paths.js";
import type {
  ContinuityConfiguration,
  ContinuitySnapshot,
  ContinuityUpdateInput,
  ContinuityUpdateResult
} from "./continuity-types.js";

export class ContinuityWorkstreamNotFoundError extends Error {
  constructor(
    readonly requestedWorkstream: string,
    readonly availableWorkstreams: string[]
  ) {
    super(`Workstream '${requestedWorkstream}' is not defined`);
    this.name = "ContinuityWorkstreamNotFoundError";
  }
}

export class ContinuityNotConfiguredError extends Error {
  constructor(readonly workstream: string) {
    super(`Workstream '${workstream}' has no continuity document configured`);
    this.name = "ContinuityNotConfiguredError";
  }
}

export class ContinuityNotMarkdownError extends Error {
  constructor(readonly configuredPath: string) {
    super("Continuity documents must be Markdown (.md)");
    this.name = "ContinuityNotMarkdownError";
  }
}

export class ContinuityStaleWriteError extends Error {
  constructor(
    readonly workstream: string,
    readonly expectedSha256: string,
    readonly currentSha256: string
  ) {
    super("Continuity has changed since it was read");
    this.name = "ContinuityStaleWriteError";
  }
}

export class ContinuityReadError extends Error {
  constructor(
    readonly workstream: string,
    readonly configuredPath: string,
    readonly absolutePath: string | null,
    options: ErrorOptions
  ) {
    super(`Could not read continuity document for '${workstream}'`, options);
    this.name = "ContinuityReadError";
  }
}

export class ContinuityUpdateError extends Error {
  readonly details: string;

  constructor(
    readonly workstream: string,
    cause: unknown
  ) {
    super(`Could not update continuity for '${workstream}'`, { cause });
    this.name = "ContinuityUpdateError";
    this.details = cause instanceof Error ? cause.message : String(cause);
  }
}

export function resolveContinuityConfiguration(
  config: PcwConfig,
  requestedWorkstream: string
): ContinuityConfiguration {
  const resolvedWorkstream = findWorkstream(config, requestedWorkstream);

  if (!resolvedWorkstream) {
    throw new ContinuityWorkstreamNotFoundError(
      requestedWorkstream,
      Object.keys(getWorkstreams(config))
    );
  }

  const configuredPath = resolvedWorkstream.config.continuity?.path;
  if (!configuredPath) {
    throw new ContinuityNotConfiguredError(resolvedWorkstream.name);
  }

  return {
    workstream: resolvedWorkstream.name,
    configuredPath
  };
}

export async function getContinuitySnapshot(
  contextRoot: string,
  config: PcwConfig,
  requestedWorkstream: string
): Promise<ContinuitySnapshot> {
  const continuity = resolveContinuityConfiguration(
    config,
    requestedWorkstream
  );
  let absolutePath: string | null = null;

  try {
    absolutePath = resolveConfiguredPath(
      contextRoot,
      continuity.configuredPath
    );
    await assertExistingPathInsideBase(contextRoot, absolutePath);
    const content = await readFile(absolutePath, "utf8");

    return {
      ...continuity,
      absolutePath,
      sha256: sha256Text(content),
      content
    };
  } catch (cause) {
    throw new ContinuityReadError(
      continuity.workstream,
      continuity.configuredPath,
      absolutePath,
      { cause }
    );
  }
}

function assertSafeHistoryWorkstreamName(workstream: string): void {
  if (
    workstream.trim().length === 0 ||
    workstream === "." ||
    workstream === ".." ||
    workstream.includes("/") ||
    workstream.includes("\\") ||
    workstream.includes("\0")
  ) {
    throw new Error(
      "Workstream name cannot be used as a safe continuity history directory"
    );
  }
}

async function createHistoryDirectory(
  contextRoot: string,
  workstream: string
): Promise<{ historyRoot: string; historyDirectory: string }> {
  assertSafeHistoryWorkstreamName(workstream);

  const metadataDirectory = resolveConfiguredPath(contextRoot, ".pcw");
  await mkdir(metadataDirectory, { recursive: true });
  await assertExistingPathInsideBase(contextRoot, metadataDirectory);

  const historyRoot = ensureInsideBase(
    metadataDirectory,
    join(metadataDirectory, "history")
  );
  await mkdir(historyRoot, { recursive: true });
  await assertExistingSourcePath(
    contextRoot,
    metadataDirectory,
    historyRoot
  );

  const historyDirectory = ensureInsideBase(
    historyRoot,
    join(historyRoot, workstream)
  );
  await mkdir(historyDirectory, { recursive: true });
  await assertExistingSourcePath(
    contextRoot,
    historyRoot,
    historyDirectory
  );

  return { historyRoot, historyDirectory };
}

export async function updateContinuity(
  contextRoot: string,
  config: PcwConfig,
  input: ContinuityUpdateInput
): Promise<ContinuityUpdateResult> {
  const continuity = resolveContinuityConfiguration(
    config,
    input.requestedWorkstream
  );

  if (extname(continuity.configuredPath).toLowerCase() !== ".md") {
    throw new ContinuityNotMarkdownError(continuity.configuredPath);
  }

  try {
    const absolutePath = resolveConfiguredPath(
      contextRoot,
      continuity.configuredPath
    );
    await assertExistingPathInsideBase(contextRoot, absolutePath);

    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new Error("Configured continuity path is not a file");
    }

    const currentContent = await readFile(absolutePath, "utf8");
    const currentSha256 = sha256Text(currentContent);

    if (currentSha256 !== input.expectedSha256) {
      throw new ContinuityStaleWriteError(
        continuity.workstream,
        input.expectedSha256,
        currentSha256
      );
    }

    const { historyRoot, historyDirectory } =
      await createHistoryDirectory(contextRoot, continuity.workstream);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = ensureInsideBase(
      historyDirectory,
      join(
        historyDirectory,
        `${timestamp}-${currentSha256.slice(0, 12)}.md`
      )
    );

    await copyFile(absolutePath, backupPath, constants.COPYFILE_EXCL);
    await assertExistingSourcePath(
      contextRoot,
      historyRoot,
      backupPath
    );

    await writeFileAtomic(absolutePath, input.content, { encoding: "utf8" });

    return {
      ...continuity,
      absolutePath,
      previousSha256: currentSha256,
      newSha256: sha256Text(input.content),
      backupPath,
      updated: true
    };
  } catch (cause) {
    if (cause instanceof ContinuityStaleWriteError) {
      throw cause;
    }
    throw new ContinuityUpdateError(continuity.workstream, cause);
  }
}
