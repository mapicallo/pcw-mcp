import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import test from "node:test";

import { PcwPathError } from "../src/filesystem/paths.js";
import {
  DEFAULT_INVENTORY_SEARCH_LIMIT,
  extractInventorySections,
  InventoryNotFileError,
  loadInventoryDocument,
  resolveInventoryPath,
  searchInventory,
  searchInventorySections
} from "../src/inventory/inventory-service.js";

async function withInventoryFilesystem<T>(
  run: (paths: {
    contextRoot: string;
    inventoryPath: string;
    outsideRoot: string;
  }) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-inventory-test-"));
  const contextRoot = join(temporaryRoot, "context");
  const catalogPath = join(contextRoot, "catalog");
  const inventoryPath = join(catalogPath, "inventory.md");
  const outsideRoot = join(temporaryRoot, "outside");

  try {
    await mkdir(catalogPath, { recursive: true });
    await mkdir(outsideRoot);
    return await run({ contextRoot, inventoryPath, outsideRoot });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("inventory path resolves inside the context root", async () => {
  await withInventoryFilesystem(async ({ contextRoot, inventoryPath }) => {
    assert.equal(
      resolveInventoryPath(contextRoot, "catalog/inventory.md"),
      inventoryPath
    );
  });
});

test("inventory document loads current content and metadata", async () => {
  await withInventoryFilesystem(async ({ contextRoot, inventoryPath }) => {
    const content = "# Synthetic inventory\n\n### Backend\nQueue notes.\n";
    await writeFile(inventoryPath, content, "utf8");

    const document = await loadInventoryDocument(
      contextRoot,
      "catalog/inventory.md"
    );

    assert.equal(document.configuredPath, "catalog/inventory.md");
    assert.equal(document.absolutePath, inventoryPath);
    assert.equal(document.content, content);
    assert.equal(document.sizeBytes, Buffer.byteLength(content));
    assert.equal(
      new Date(document.modifiedAt).toISOString(),
      document.modifiedAt
    );
  });
});

test("inventory path escaping the context root is rejected", async () => {
  await withInventoryFilesystem(async ({ contextRoot }) => {
    await assert.rejects(
      loadInventoryDocument(contextRoot, "../outside/inventory.md"),
      (error) => error instanceof PcwPathError
    );
  });
});

test("inventory symlink or junction escaping the root is rejected", async (t) => {
  await withInventoryFilesystem(async ({ contextRoot, outsideRoot }) => {
    await writeFile(
      join(outsideRoot, "inventory.md"),
      "outside sentinel",
      "utf8"
    );
    const linkPath = join(contextRoot, "linked");

    try {
      await symlink(
        outsideRoot,
        linkPath,
        platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
        t.skip("Symlink creation is unavailable: " + code);
        return;
      }
      throw error;
    }

    await assert.rejects(
      loadInventoryDocument(contextRoot, "linked/inventory.md"),
      (error) => error instanceof PcwPathError
    );
  });
});

test("inventory loader rejects a configured directory", async () => {
  await withInventoryFilesystem(async ({ contextRoot }) => {
    await assert.rejects(
      loadInventoryDocument(contextRoot, "catalog"),
      (error) => error instanceof InventoryNotFileError
    );
  });
});

test("section extraction uses level-three headings and includes each heading", () => {
  const sections = extractInventorySections(
    "### Backend API\nPurpose: HTTP validation.\n\n" +
      "### Observability\nPurpose: Metrics."
  );

  assert.deepEqual(sections, [
    {
      title: "Backend API",
      content: "### Backend API\nPurpose: HTTP validation."
    },
    {
      title: "Observability",
      content: "### Observability\nPurpose: Metrics."
    }
  ]);
});

test("content before the first section is an inventory introduction", () => {
  const sections = extractInventorySections(
    "# Inventory\nSynthetic preamble.\n\n### Backend\nBody."
  );

  assert.deepEqual(sections[0], {
    title: "Inventory introduction",
    content: "# Inventory\nSynthetic preamble."
  });
});

test("section extraction preserves document order", () => {
  const sections = extractInventorySections(
    "### Third\n3\n### First\n1\n### Second\n2"
  );

  assert.deepEqual(sections.map((section) => section.title), [
    "Third",
    "First",
    "Second"
  ]);
});

test("an empty headed section remains searchable by its heading", () => {
  const sections = extractInventorySections(
    "### Empty\n### Populated\nBody"
  );

  assert.deepEqual(sections[0], {
    title: "Empty",
    content: "### Empty"
  });
});

test("empty and heading-free inventories preserve current behavior", () => {
  assert.deepEqual(extractInventorySections(""), []);
  assert.deepEqual(extractInventorySections("plain synthetic inventory"), [
    {
      title: "Inventory introduction",
      content: "plain synthetic inventory"
    }
  ]);
});

const searchableSections = extractInventorySections(
  "### Backend API\nPurpose: HTTP validation and testing.\n\n" +
    "### Observability\nPurpose: Logging and metrics.\n\n" +
    "### Payments\nPurpose: Fictional settlement workflow."
);

test("inventory search is case-insensitive", () => {
  const matches = searchInventorySections(
    searchableSections,
    "HTTP VALIDATION"
  );
  assert.deepEqual(matches.map((match) => match.title), ["Backend API"]);
});

test("inventory search matches section body content", () => {
  const matches = searchInventorySections(
    searchableSections,
    "logging and metrics"
  );
  assert.deepEqual(matches.map((match) => match.title), ["Observability"]);
});

test("inventory search matches heading content", () => {
  const matches = searchInventorySections(searchableSections, "payments");
  assert.deepEqual(matches.map((match) => match.title), ["Payments"]);
});

test("inventory search returns an empty list when nothing matches", () => {
  assert.deepEqual(
    searchInventorySections(searchableSections, "absent term"),
    []
  );
});

test("inventory search respects an explicit limit", () => {
  const matches = searchInventorySections(searchableSections, "purpose", 2);
  assert.deepEqual(matches.map((match) => match.title), [
    "Backend API",
    "Observability"
  ]);
});

test("inventory search accepts a limit greater than the result count", () => {
  assert.equal(
    searchInventorySections(searchableSections, "purpose", 20).length,
    3
  );
});

test("inventory search defaults to eight results", () => {
  const sections = extractInventorySections(
    Array.from(
      { length: 10 },
      (_, index) =>
        "### Section " + (index + 1) + "\nCommon synthetic topic."
    ).join("\n")
  );

  assert.equal(DEFAULT_INVENTORY_SEARCH_LIMIT, 8);
  assert.equal(searchInventorySections(sections, "common").length, 8);
});

test("repeated matches within one section produce one result", () => {
  const sections = extractInventorySections(
    "### Repeated\nmetric metric metric\n### Other\nNo match."
  );
  assert.equal(searchInventorySections(sections, "metric").length, 1);
});

test("whitespace-only queries retain the current match-all behavior", () => {
  assert.equal(searchInventorySections(searchableSections, "   ").length, 3);
});

test("inventory reads and searches reflect file changes without caching", async () => {
  await withInventoryFilesystem(async ({ contextRoot, inventoryPath }) => {
    await writeFile(
      inventoryPath,
      "### Version A\nalpha marker",
      "utf8"
    );
    const first = await searchInventory(
      contextRoot,
      "catalog/inventory.md",
      "alpha"
    );

    await writeFile(
      inventoryPath,
      "### Version B\nbeta marker",
      "utf8"
    );
    const second = await searchInventory(
      contextRoot,
      "catalog/inventory.md",
      "beta"
    );

    assert.equal(first.matches[0].title, "Version A");
    assert.equal(second.matches[0].title, "Version B");
    assert.match(second.document.content, /beta marker/);
  });
});

test("inventory search does not inspect unrelated source documents", async () => {
  await withInventoryFilesystem(async ({ contextRoot, inventoryPath }) => {
    await writeFile(
      inventoryPath,
      "### Inventory only\nKnown catalog entry.",
      "utf8"
    );
    const sourceDirectory = join(contextRoot, "sources");
    await mkdir(sourceDirectory);
    await writeFile(
      join(sourceDirectory, "unrelated.md"),
      "unique-source-only-marker",
      "utf8"
    );

    const result = await searchInventory(
      contextRoot,
      "catalog/inventory.md",
      "unique-source-only-marker"
    );

    assert.deepEqual(result.matches, []);
  });
});
