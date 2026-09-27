import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ContextInitializationError,
  initializeContextRoot
} from "../src/initialization/context-initializer.js";
import { getWorkstreams, loadPcwConfig } from "../src/config/pcw-config.js";
import { callTool, withServer } from "./mcp-test-client.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const bootstrapEntry = join(repositoryRoot, "dist", "bootstrap.js");

async function withTempRoot<T>(
  run: (root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pcw-context-init-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectInitializationError(
  operation: Promise<unknown>,
  code: ContextInitializationError["code"]
): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ContextInitializationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("initializes a missing final directory with deterministic minimal configuration", () =>
  withTempRoot(async (root) => {
    const contextRoot = join(root, "Project With Spaces \u00d1");
    const result = await initializeContextRoot({ contextRoot });
    const content = await readFile(join(contextRoot, "pcw.yml"), "utf8");

    assert.deepEqual(result, {
      status: "initialized",
      contextRoot,
      configPath: join(contextRoot, "pcw.yml"),
      workstreamCount: 0,
      createdDirectory: true
    });
    assert.equal(content, "version: 1\nworkstreams: {}\n");
    assert.doesNotMatch(content, /timestamp|created|user|host|random/iu);

    const loaded = await loadPcwConfig(contextRoot);
    assert.deepEqual(getWorkstreams(loaded.config), {});
  }));

test("initializes an existing empty directory and creates no extra directories", () =>
  withTempRoot(async (root) => {
    const contextRoot = join(root, "empty");
    await mkdir(contextRoot);

    const result = await initializeContextRoot({ contextRoot });
    assert.equal(result.createdDirectory, false);
    assert.deepEqual(await readdir(contextRoot), ["pcw.yml"]);
  }));

test("valid initialized roots are idempotent and remain byte-for-byte unchanged", () =>
  withTempRoot(async (root) => {
    const contextRoot = join(root, "existing");
    await initializeContextRoot({ contextRoot });
    const configPath = join(contextRoot, "pcw.yml");
    const before = await readFile(configPath);

    const result = await initializeContextRoot({ contextRoot });
    assert.equal(result.status, "already-initialized");
    assert.equal(result.workstreamCount, 0);
    assert.deepEqual(await readFile(configPath), before);
  }));

test("existing valid workstream roots are accepted without mutation", () =>
  withTempRoot(async (root) => {
    const contextRoot = join(root, "existing-workstream");
    await mkdir(contextRoot);
    const configPath = join(contextRoot, "pcw.yml");
    const content = [
      "# preserve this comment",
      "version: 1",
      "workstreams:",
      "  EXISTING:",
      "    continuity:",
      "      path: continuity/EXISTING.md",
      ""
    ].join("\n");
    await writeFile(configPath, content);

    const result = await initializeContextRoot({ contextRoot });
    assert.equal(result.status, "already-initialized");
    assert.equal(result.workstreamCount, 1);
    assert.equal(await readFile(configPath, "utf8"), content);
  }));

test("invalid pcw.yml and unrelated non-empty directories are refused without mutation", () =>
  withTempRoot(async (root) => {
    const invalidRoot = join(root, "invalid");
    await mkdir(invalidRoot);
    const invalidPath = join(invalidRoot, "pcw.yml");
    await writeFile(invalidPath, "workstreams: []\n");
    await expectInitializationError(
      initializeContextRoot({ contextRoot: invalidRoot }),
      "PCW_CONTEXT_CONFIG_INVALID"
    );
    assert.equal(await readFile(invalidPath, "utf8"), "workstreams: []\n");

    const occupiedRoot = join(root, "occupied");
    await mkdir(occupiedRoot);
    const unrelatedPath = join(occupiedRoot, "notes.txt");
    await writeFile(unrelatedPath, "preserve me");
    await expectInitializationError(
      initializeContextRoot({ contextRoot: occupiedRoot }),
      "PCW_CONTEXT_NOT_EMPTY"
    );
    assert.equal(await readFile(unrelatedPath, "utf8"), "preserve me");
    await assert.rejects(access(join(occupiedRoot, "pcw.yml")), { code: "ENOENT" });
  }));

test("unsafe roots and protected runtime overlap are rejected", () =>
  withTempRoot(async (root) => {
    await expectInitializationError(
      initializeContextRoot({ contextRoot: "." }),
      "PCW_CONTEXT_INITIALIZATION_UNSAFE"
    );
    await expectInitializationError(
      initializeContextRoot({ contextRoot: parse(root).root }),
      "PCW_CONTEXT_INITIALIZATION_UNSAFE"
    );
    await expectInitializationError(
      initializeContextRoot({ contextRoot: join(root, "missing-parent", "context") }),
      "PCW_CONTEXT_INITIALIZATION_UNSAFE"
    );

    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    await expectInitializationError(
      initializeContextRoot({
        contextRoot: join(runtimeRoot, "context"),
        protectedPaths: [runtimeRoot]
      }),
      "PCW_CONTEXT_INITIALIZATION_UNSAFE"
    );
  }));

test("symbolic-link or reparse-point parents are rejected when supported", async (t) =>
  withTempRoot(async (root) => {
    const actualParent = join(root, "actual-parent");
    const linkedParent = join(root, "linked-parent");
    await mkdir(actualParent);
    try {
      await symlink(actualParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("Link creation is not permitted in this environment");
        return;
      }
      throw error;
    }

    await expectInitializationError(
      initializeContextRoot({ contextRoot: join(linkedParent, "context") }),
      "PCW_CONTEXT_INITIALIZATION_UNSAFE"
    );
  }));

test("a concurrent directory change aborts publication and preserves the competing file", () =>
  withTempRoot(async (root) => {
    const contextRoot = join(root, "conflict");
    await mkdir(contextRoot);
    const competingPath = join(contextRoot, "other-process.txt");

    await expectInitializationError(
      initializeContextRoot(
        { contextRoot },
        { beforePublish: () => writeFile(competingPath, "concurrent") }
      ),
      "PCW_CONTEXT_INITIALIZATION_CONFLICT"
    );
    assert.equal(await readFile(competingPath, "utf8"), "concurrent");
    await assert.rejects(access(join(contextRoot, "pcw.yml")), { code: "ENOENT" });
  }));

test("bootstrap CLI emits one machine-readable result and no MCP output", () =>
  withTempRoot(async (root) => {
    const contextRoot = join(root, "CLI Context \u00d1");
    const success = await execFileAsync(process.execPath, [
      bootstrapEntry,
      "init-context",
      "--context-root",
      contextRoot
    ]);

    assert.equal(success.stderr, "");
    assert.deepEqual(JSON.parse(success.stdout), {
      ok: true,
      status: "initialized",
      contextRoot,
      configPath: join(contextRoot, "pcw.yml"),
      workstreamCount: 0,
      createdDirectory: true
    });
  }));

test("empty initialized context supports MCP startup and first workstream creation", () =>
  withTempRoot(async (root) => {
    const contextRoot = join(root, "mcp-empty");
    await initializeContextRoot({ contextRoot });

    await withServer(contextRoot, async (client) => {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 16);

      const project = await callTool<{
        version: number;
        project: { id: null; name: null };
        inventory: null;
      }>(client, "get_project_info");
      const empty = await callTool<Array<{ name: string }>>(
        client,
        "list_workstreams"
      );
      assert.equal(project.isError, false);
      assert.equal(project.data.version, 1);
      assert.deepEqual(project.data.project, { id: null, name: null });
      assert.equal(project.data.inventory, null);
      assert.deepEqual(empty.data, []);

      const created = await callTool<{ workstream: string; created: boolean }>(
        client,
        "create_workstream",
        { name: "FIRST-LAB" }
      );
      assert.equal(created.isError, false);
      assert.deepEqual(
        { workstream: created.data.workstream, created: created.data.created },
        { workstream: "FIRST-LAB", created: true }
      );

      const populated = await callTool<Array<{ name: string }>>(
        client,
        "list_workstreams"
      );
      assert.deepEqual(populated.data.map(({ name }) => name), ["FIRST-LAB"]);
    });
  }));