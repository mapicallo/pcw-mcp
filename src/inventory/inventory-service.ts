import { readFile, stat, writeFile } from "node:fs/promises";

import writeFileAtomic from "write-file-atomic";

import { sha256Text } from "../filesystem/hashing.js";
import {
  assertExistingPathInsideBase,
  assertExistingSourcePath,
  ensureDirectoryInsideBase,
  resolveConfiguredPath
} from "../filesystem/paths.js";
import type {
  InventoryDocument,
  InventorySearchResult,
  InventorySection,
  InventoryUpdateInput,
  InventoryUpdateResult
} from "./inventory-types.js";

export const DEFAULT_INVENTORY_SEARCH_LIMIT = 8;

export class InventoryNotFileError extends Error {
  constructor() {
    super("Configured inventory path is not a file");
    this.name = "InventoryNotFileError";
  }
}

export class InventoryStaleWriteError extends Error {
  constructor(
    readonly expectedSha256: string,
    readonly currentSha256: string
  ) {
    super("Inventory has changed since it was read");
    this.name = "InventoryStaleWriteError";
  }
}

export class InventoryUpdateError extends Error {
  readonly details: string;

  constructor(cause: unknown) {
    super("Could not update the configured inventory", { cause });
    this.name = "InventoryUpdateError";
    this.details = cause instanceof Error ? cause.message : String(cause);
  }
}

export type InventoryUpdateDependencies = {
  writeBackup?: (path: string, content: string) => Promise<void>;
  writeInventoryAtomic?: (path: string, content: string) => Promise<void>;
};

export function resolveInventoryPath(
  contextRoot: string,
  configuredPath: string
): string {
  return resolveConfiguredPath(contextRoot, configuredPath);
}

export async function loadInventoryDocument(
  contextRoot: string,
  configuredPath: string
): Promise<InventoryDocument> {
  const absolutePath = resolveInventoryPath(contextRoot, configuredPath);
  await assertExistingPathInsideBase(contextRoot, absolutePath);
  const info = await stat(absolutePath);

  if (!info.isFile()) {
    throw new InventoryNotFileError();
  }

  const content = await readFile(absolutePath, "utf8");

  return {
    configuredPath,
    absolutePath,
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    sha256: sha256Text(content),
    content
  };
}

export async function updateInventory(
  contextRoot: string,
  configuredPath: string,
  input: InventoryUpdateInput,
  dependencies: InventoryUpdateDependencies = {}
): Promise<InventoryUpdateResult> {
  try {
    const current = await loadInventoryDocument(contextRoot, configuredPath);
    if (current.sha256 !== input.expectedSha256) {
      throw new InventoryStaleWriteError(
        input.expectedSha256,
        current.sha256
      );
    }

    const historyDirectory = resolveConfiguredPath(
      contextRoot,
      ".pcw/history/inventory"
    );
    await ensureDirectoryInsideBase(contextRoot, historyDirectory);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = resolveConfiguredPath(
      contextRoot,
      `.pcw/history/inventory/${timestamp}-${current.sha256.slice(0, 12)}.md`
    );
    const writeBackup = dependencies.writeBackup ??
      ((path: string, content: string) =>
        writeFile(path, content, { encoding: "utf8", flag: "wx" }));
    const writeInventoryAtomic = dependencies.writeInventoryAtomic ??
      ((path: string, content: string) =>
        writeFileAtomic(path, content, { encoding: "utf8" }));

    await writeBackup(backupPath, current.content);
    await assertExistingSourcePath(
      contextRoot,
      historyDirectory,
      backupPath
    );
    await writeInventoryAtomic(current.absolutePath, input.content);

    return {
      configuredPath,
      absolutePath: current.absolutePath,
      previousSha256: current.sha256,
      newSha256: sha256Text(input.content),
      backupPath,
      updated: true
    };
  } catch (cause) {
    if (cause instanceof InventoryStaleWriteError) {
      throw cause;
    }
    throw new InventoryUpdateError(cause);
  }
}

export function extractInventorySections(
  markdown: string
): InventorySection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: InventorySection[] = [];
  let currentTitle = "Inventory introduction";
  let currentLines: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+)$/);

    if (heading) {
      if (currentLines.length > 0) {
        sections.push({
          title: currentTitle,
          content: currentLines.join("\n").trim()
        });
      }

      currentTitle = heading[1].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      title: currentTitle,
      content: currentLines.join("\n").trim()
    });
  }

  return sections.filter((section) => section.content.length > 0);
}

export function searchInventorySections(
  sections: readonly InventorySection[],
  query: string,
  limit = DEFAULT_INVENTORY_SEARCH_LIMIT
): InventorySection[] {
  const normalizedQuery = query.trim().toLowerCase();

  return sections
    .filter((section) =>
      section.content.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, limit)
    .map((section) => ({
      title: section.title,
      content: section.content
    }));
}

export async function searchInventory(
  contextRoot: string,
  configuredPath: string,
  query: string,
  limit = DEFAULT_INVENTORY_SEARCH_LIMIT
): Promise<InventorySearchResult> {
  const document = await loadInventoryDocument(contextRoot, configuredPath);
  const sections = extractInventorySections(document.content);

  return {
    document,
    matches: searchInventorySections(sections, query, limit)
  };
}
