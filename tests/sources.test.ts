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
  isDocxSourcePath,
  readDocxFile
} from "../src/readers/docx-reader.js";
import {
  isPdfSourcePath,
  readPdfFile
} from "../src/readers/pdf-reader.js";
import {
  isTextSourcePath,
  readTextFile
} from "../src/readers/text-reader.js";
import {
  discoverSources,
  resolveSourceFile
} from "../src/sources/source-service.js";
import {
  callTool,
  fixtureRoot,
  withServer
} from "./mcp-test-client.js";

const fixtureSection = join(
  fixtureRoot,
  "engineering",
  "backend-material"
);

async function withSourceFilesystem<T>(
  run: (paths: {
    contextRoot: string;
    sectionPath: string;
    outsideRoot: string;
  }) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-sources-test-"));
  const contextRoot = join(temporaryRoot, "context");
  const sectionPath = join(contextRoot, "section");
  const outsideRoot = join(temporaryRoot, "outside");

  try {
    await mkdir(sectionPath, { recursive: true });
    await mkdir(outsideRoot);
    return await run({ contextRoot, sectionPath, outsideRoot });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("source discovery lists sorted file and directory metadata", async () => {
  await withSourceFilesystem(async ({ contextRoot, sectionPath }) => {
    await mkdir(join(sectionPath, "nested"));
    await writeFile(join(sectionPath, "source.txt"), "synthetic", "utf8");

    const listing = await discoverSources(contextRoot, "section");

    assert.equal(listing.absolutePath, sectionPath);
    assert.deepEqual(
      listing.sources.map(({ name, type }) => ({ name, type })),
      [
        { name: "nested", type: "directory" },
        { name: "source.txt", type: "file" }
      ]
    );
    const file = listing.sources[1];
    assert.equal(file.sizeBytes, Buffer.byteLength("synthetic"));
    assert.equal(new Date(file.modifiedAt).toISOString(), file.modifiedAt);
  });
});

test("source discovery returns an empty list for an empty directory", async () => {
  await withSourceFilesystem(async ({ contextRoot }) => {
    const listing = await discoverSources(contextRoot, "section");
    assert.deepEqual(listing.sources, []);
  });
});

test("source discovery rejects a missing configured directory", async () => {
  await withSourceFilesystem(async ({ contextRoot }) => {
    await assert.rejects(discoverSources(contextRoot, "missing"));
  });
});

test("source file resolution returns current file metadata", async () => {
  await withSourceFilesystem(async ({ contextRoot, sectionPath }) => {
    await writeFile(join(sectionPath, "source.txt"), "metadata", "utf8");

    const source = await resolveSourceFile(contextRoot, "section", "source.txt");

    assert.equal(source.absolutePath, join(sectionPath, "source.txt"));
    assert.equal(source.sizeBytes, Buffer.byteLength("metadata"));
    assert.equal(new Date(source.modifiedAt).toISOString(), source.modifiedAt);
  });
});

test("source file resolution rejects directories", async () => {
  await withSourceFilesystem(async ({ contextRoot }) => {
    await assert.rejects(
      resolveSourceFile(contextRoot, "section", "."),
      /Source is not a file/
    );
  });
});

test("source file resolution rejects traversal outside its section", async () => {
  await withSourceFilesystem(async ({ contextRoot }) => {
    await writeFile(join(contextRoot, "sibling.txt"), "sentinel", "utf8");

    await assert.rejects(
      resolveSourceFile(contextRoot, "section", "../sibling.txt"),
      (error) => error instanceof PcwPathError
    );
  });
});

test("source file resolution rejects an external symlink or junction", async (t) => {
  await withSourceFilesystem(async ({ contextRoot, sectionPath, outsideRoot }) => {
    const linkPath = join(sectionPath, "linked");
    await writeFile(join(outsideRoot, "sentinel.txt"), "sentinel", "utf8");

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
      resolveSourceFile(contextRoot, "section", join("linked", "sentinel.txt")),
      (error) => error instanceof PcwPathError
    );
  });
});

test("text reader reads Markdown as UTF-8 text", async () => {
  const source = join(fixtureSection, "backend-notes.md");
  assert.equal(isTextSourcePath(source), true);
  assert.match(await readTextFile(source), /bounded retries/);
});

test("text reader reads TXT as UTF-8 text", async () => {
  const source = join(fixtureRoot, "knowledge", "base", "glossary.txt");
  assert.equal(isTextSourcePath(source), true);
  assert.match(await readTextFile(source), /fictional entry point/);
});

test("text reader rejects unsupported extensions", async () => {
  const source = join(fixtureSection, "synthetic.pdf");
  assert.equal(isTextSourcePath(source), false);
  await assert.rejects(readTextFile(source), /only supports Markdown/);
});

test("text reader rejects directory input", async () => {
  await withSourceFilesystem(async ({ sectionPath }) => {
    const directory = join(sectionPath, "directory.md");
    await mkdir(directory);
    await assert.rejects(readTextFile(directory), /Source is not a file/);
  });
});

test("DOCX reader extracts synthetic text and warning structure", async () => {
  const source = join(fixtureSection, "synthetic.docx");
  assert.equal(isDocxSourcePath(source), true);

  const result = await readDocxFile(source);
  assert.match(result.text, /PCW Synthetic Document/);
  assert.match(result.text, /Workstream: BACKEND/);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(
    result.warnings.every(
      (warning) =>
        typeof warning.type === "string" &&
        typeof warning.message === "string"
    )
  );
});

test("DOCX reader rejects non-DOCX extensions", async () => {
  const source = join(fixtureSection, "backend-notes.md");
  assert.equal(isDocxSourcePath(source), false);
  await assert.rejects(readDocxFile(source), /only supports DOCX/);
});

test("PDF reader extracts synthetic selectable text", async () => {
  const source = join(fixtureSection, "synthetic.pdf");
  assert.equal(isPdfSourcePath(source), true);

  const text = await readPdfFile(source);
  assert.match(text, /PCW Synthetic Document/);
  assert.match(text, /Status: TEST/);
});

test("PDF reader rejects non-PDF extensions", async () => {
  const source = join(fixtureSection, "backend-notes.md");
  assert.equal(isPdfSourcePath(source), false);
  await assert.rejects(readPdfFile(source), /only supports PDF/);
});

test("read_docx_source preserves the MCP response contract", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      scope: string;
      name: string;
      source: string;
      absolutePath: string;
      sizeBytes: number;
      modifiedAt: string;
      text: string;
      warnings: unknown[];
    }>(client, "read_docx_source", {
      scope: "workstream",
      name: "backend",
      source: "synthetic.docx"
    });

    assert.equal(response.isError, false);
    assert.equal(response.data.name, "BACKEND");
    assert.equal(response.data.source, "synthetic.docx");
    assert.match(response.data.absolutePath, /synthetic\.docx$/);
    assert.ok(response.data.sizeBytes > 0);
    assert.equal(
      new Date(response.data.modifiedAt).toISOString(),
      response.data.modifiedAt
    );
    assert.match(response.data.text, /Status: TEST/);
    assert.ok(Array.isArray(response.data.warnings));
  });
});

test("read_pdf_source preserves the MCP response contract", async () => {
  await withServer(fixtureRoot, async (client) => {
    const response = await callTool<{
      scope: string;
      name: string;
      source: string;
      absolutePath: string;
      sizeBytes: number;
      modifiedAt: string;
      text: string;
    }>(client, "read_pdf_source", {
      scope: "workstream",
      name: "BACKEND",
      source: "synthetic.pdf"
    });

    assert.equal(response.isError, false);
    assert.equal(response.data.name, "BACKEND");
    assert.equal(response.data.source, "synthetic.pdf");
    assert.match(response.data.absolutePath, /synthetic\.pdf$/);
    assert.ok(response.data.sizeBytes > 0);
    assert.equal(
      new Date(response.data.modifiedAt).toISOString(),
      response.data.modifiedAt
    );
    assert.match(response.data.text, /Workstream: BACKEND/);
  });
});
