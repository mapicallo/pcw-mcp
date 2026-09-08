import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  assertExistingPathInsideBase,
  assertExistingSourcePath,
  resolveConfiguredPath,
  resolveSourcePath
} from "../filesystem/paths.js";
import type {
  ResolvedSourceFile,
  SourceEntry,
  SourceListing
} from "./source-types.js";

export async function discoverSources(
  contextRoot: string,
  configuredPath: string
): Promise<SourceListing> {
  const absolutePath = resolveConfiguredPath(contextRoot, configuredPath);
  await assertExistingPathInsideBase(contextRoot, absolutePath);

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const sources: SourceEntry[] = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(absolutePath, entry.name);
      await assertExistingSourcePath(contextRoot, absolutePath, entryPath);
      const info = await stat(entryPath);

      return {
        name: entry.name,
        type: entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString()
      };
    })
  );

  sources.sort((left, right) => left.name.localeCompare(right.name));
  return { absolutePath, sources };
}

export async function resolveSourceFile(
  contextRoot: string,
  configuredSectionPath: string,
  source: string
): Promise<ResolvedSourceFile> {
  const basePath = resolveConfiguredPath(contextRoot, configuredSectionPath);
  const absolutePath = resolveSourcePath(contextRoot, basePath, source);

  await assertExistingSourcePath(contextRoot, basePath, absolutePath);
  const info = await stat(absolutePath);

  if (!info.isFile()) {
    throw new Error("Source is not a file");
  }

  return {
    absolutePath,
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString()
  };
}
