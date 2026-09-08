import { readFile, stat } from "node:fs/promises";

import {
  assertExistingPathInsideBase,
  resolveConfiguredPath
} from "../filesystem/paths.js";
import type {
  InventoryDocument,
  InventorySearchResult,
  InventorySection
} from "./inventory-types.js";

export const DEFAULT_INVENTORY_SEARCH_LIMIT = 8;

export class InventoryNotFileError extends Error {
  constructor() {
    super("Configured inventory path is not a file");
    this.name = "InventoryNotFileError";
  }
}

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

  return {
    configuredPath,
    absolutePath,
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    content: await readFile(absolutePath, "utf8")
  };
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
