import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";

import {
  assertExistingPathInsideBase,
  ensureInsideBase,
  PcwPathError,
  resolveConfiguredPath,
  resolveSourcePath
} from "../src/filesystem/paths.js";
import { sha256Text } from "../src/filesystem/hashing.js";

function assertPathRejected(run: () => unknown): void {
  assert.throws(run, (error) => error instanceof PcwPathError);
}

async function withFilesystem<T>(
  run: (paths: {
    temporaryRoot: string;
    contextRoot: string;
    outsideRoot: string;
  }) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-filesystem-test-"));
  const contextRoot = join(temporaryRoot, "context");
  const outsideRoot = join(temporaryRoot, "outside");

  try {
    await mkdir(contextRoot);
    await mkdir(outsideRoot);
    return await run({ temporaryRoot, contextRoot, outsideRoot });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("normal relative configured path resolves inside root", () => {
  const root = resolve("synthetic-root");

  assert.equal(
    resolveConfiguredPath(root, "inventory.md"),
    join(root, "inventory.md")
  );
});

test("nested relative configured path resolves inside root", () => {
  const root = resolve("synthetic-root");

  assert.equal(
    resolveConfiguredPath(root, join("docs", "nested", "source.md")),
    join(root, "docs", "nested", "source.md")
  );
});

test("parent traversal escaping root is rejected", () => {
  const root = resolve("synthetic-root");

  assertPathRejected(() =>
    resolveConfiguredPath(root, join("..", "outside.txt"))
  );
});

test("multiple traversal segments escaping root are rejected", () => {
  const root = resolve("synthetic-root");

  assertPathRejected(() =>
    resolveConfiguredPath(root, join("..", "..", "outside.txt"))
  );
});

test("absolute path outside root is rejected", () => {
  const root = resolve("synthetic-root");
  const outside = resolve("outside-root", "source.txt");

  assertPathRejected(() => resolveConfiguredPath(root, outside));
});

test("absolute path inside root remains supported", () => {
  const root = resolve("synthetic-root");
  const inside = join(root, "docs", "source.txt");

  assert.equal(resolveConfiguredPath(root, inside), inside);
});

test("sibling path with a similar string prefix is rejected", () => {
  const root = resolve("context");
  const sibling = join(dirname(root), "context-other", "source.txt");

  assertPathRejected(() => ensureInsideBase(root, sibling));
});

test("configured inventory path escaping root is rejected", () => {
  assertPathRejected(() =>
    resolveConfiguredPath(resolve("context"), "../inventory.md")
  );
});

test("configured shared-context path escaping root is rejected", () => {
  assertPathRejected(() =>
    resolveConfiguredPath(resolve("context"), "../../shared")
  );
});

test("configured workstream context path escaping root is rejected", () => {
  assertPathRejected(() =>
    resolveConfiguredPath(resolve("context"), "../workstream")
  );
});

test("configured continuity path escaping root is rejected", () => {
  assertPathRejected(() =>
    resolveConfiguredPath(resolve("context"), "../continuity/WORK.md")
  );
});

test("source path cannot escape its configured section", () => {
  const root = resolve("context");
  const section = join(root, "workstreams", "BACKEND");

  assertPathRejected(() =>
    resolveSourcePath(root, section, "../OPERATIONS/source.md")
  );
});

test("Windows-style traversal is rejected on Windows", (t) => {
  if (platform !== "win32") {
    t.skip("Backslash is not a path separator on this platform");
    return;
  }

  assertPathRejected(() =>
    resolveConfiguredPath(resolve("context"), "..\\outside.txt")
  );
});

test("realpath containment rejects a symlink or junction to outside", async (t) => {
  await withFilesystem(async ({ contextRoot, outsideRoot }) => {
    const outsideFile = join(outsideRoot, "sentinel.txt");
    const linkPath = join(contextRoot, "linked");
    await writeFile(outsideFile, "synthetic sentinel", "utf8");

    try {
      await symlink(
        outsideRoot,
        linkPath,
        platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
        t.skip(`Symlink creation is unavailable: ${code}`);
        return;
      }

      throw error;
    }

    const candidate = resolveConfiguredPath(
      contextRoot,
      join("linked", "sentinel.txt")
    );

    await assert.rejects(
      assertExistingPathInsideBase(contextRoot, candidate),
      (error) => error instanceof PcwPathError
    );
  });
});

test("SHA-256 helper returns the expected lowercase UTF-8 digest", () => {
  assert.equal(
    sha256Text("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  assert.match(sha256Text("abc"), /^[a-f0-9]{64}$/);
});

test("same text produces the same SHA-256", () => {
  assert.equal(sha256Text("repeatable"), sha256Text("repeatable"));
});

test("changed text produces a different SHA-256", () => {
  assert.notEqual(sha256Text("before"), sha256Text("after"));
});
