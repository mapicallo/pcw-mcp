import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PCW_RUNTIME_USAGE,
  resolveRuntimeOptions,
  RuntimeConfigurationError,
  validateRuntimeContextRoot
} from "../src/runtime/context-root.js";
import { PCW_SOFTWARE_VERSION } from "../src/version.js";
import {
  callTool,
  fixtureRoot,
  withServerUsingCli
} from "./mcp-test-client.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(repositoryRoot, "dist", "server.js");

function assertRuntimeError(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof RuntimeConfigurationError);
    assert.match(error.message, pattern);
    return true;
  });
}

function cleanProcessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.PCW_CONTEXT_ROOT;
  return environment;
}

function runEntrypoint(args: readonly string[]) {
  return spawnSync(process.execPath, [serverEntry, ...args], {
    cwd: repositoryRoot,
    env: cleanProcessEnvironment(),
    encoding: "utf8",
    timeout: 10_000
  });
}

test("runtime resolves CLI context root and gives it precedence over environment", () => {
  const cliRoot = resolve("synthetic-cli-root");
  const environmentRoot = resolve("synthetic-environment-root");

  assert.deepEqual(
    resolveRuntimeOptions({
      argv: ["--context-root", cliRoot],
      environment: { PCW_CONTEXT_ROOT: environmentRoot }
    }),
    { mode: "server", contextRoot: cliRoot }
  );
});

test("runtime resolves PCW_CONTEXT_ROOT when CLI root is absent", () => {
  const environmentRoot = resolve("synthetic-environment-root");

  assert.deepEqual(
    resolveRuntimeOptions({
      argv: [],
      environment: { PCW_CONTEXT_ROOT: environmentRoot }
    }),
    { mode: "server", contextRoot: environmentRoot }
  );
});

test("runtime rejects missing, empty, and whitespace-only roots", () => {
  assertRuntimeError(
    () => resolveRuntimeOptions({ argv: [], environment: {} }),
    /not configured/
  );
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: [],
        environment: { PCW_CONTEXT_ROOT: "" }
      }),
    /not configured/
  );
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: [],
        environment: { PCW_CONTEXT_ROOT: "   " }
      }),
    /not configured/
  );
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: ["--context-root", "   "],
        environment: { PCW_CONTEXT_ROOT: fixtureRoot }
      }),
    /must not be empty/
  );
});

test("runtime rejects missing CLI values, duplicate roots, and unknown options", () => {
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: ["--context-root"],
        environment: {}
      }),
    /requires a path value/
  );
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: ["--context-root", "--version"],
        environment: {}
      }),
    /requires a path value/
  );
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: ["--context-root", fixtureRoot, "--context-root", fixtureRoot],
        environment: {}
      }),
    /only once/
  );
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: ["--unknown-option"],
        environment: {}
      }),
    /Unknown option/
  );
});

test("runtime recognizes standalone help and version modes", () => {
  assert.deepEqual(resolveRuntimeOptions({ argv: ["--help"], environment: {} }), {
    mode: "help"
  });
  assert.deepEqual(
    resolveRuntimeOptions({ argv: ["--version"], environment: {} }),
    { mode: "version" }
  );
  assertRuntimeError(
    () =>
      resolveRuntimeOptions({
        argv: ["--help", "--version"],
        environment: {}
      }),
    /cannot be combined/
  );
});

test("runtime validates an existing context directory with a pcw.yml file", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-runtime-valid-"));
  try {
    await writeFile(join(temporaryRoot, "pcw.yml"), "project: {}\n", "utf8");
    await validateRuntimeContextRoot(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime rejects missing roots, files as roots, and missing pcw.yml", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-runtime-invalid-"));
  try {
    const fileRoot = join(temporaryRoot, "not-a-directory");
    const emptyDirectory = join(temporaryRoot, "empty");
    await writeFile(fileRoot, "synthetic", "utf8");
    await mkdir(emptyDirectory);

    await assert.rejects(
      validateRuntimeContextRoot(join(temporaryRoot, "missing")),
      /does not exist/
    );
    await assert.rejects(validateRuntimeContextRoot(fileRoot), /not a directory/);
    await assert.rejects(
      validateRuntimeContextRoot(emptyDirectory),
      /pcw\.yml was not found/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime rejects a pcw.yml path that is not a file", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-runtime-config-"));
  try {
    await mkdir(join(temporaryRoot, "pcw.yml"));
    await assert.rejects(
      validateRuntimeContextRoot(temporaryRoot),
      /pcw\.yml is not a file/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("compiled help and version exit without starting MCP", () => {
  const help = runEntrypoint(["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, `${PCW_RUNTIME_USAGE}\n`);
  assert.equal(help.stderr, "");

  const version = runEntrypoint(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${PCW_SOFTWARE_VERSION}\n`);
  assert.equal(version.stderr, "");
});

test("compiled entrypoint fails safely without a configured root", () => {
  const result = runEntrypoint([]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /PCW context root is not configured/);
  assert.doesNotMatch(result.stderr, /RuntimeConfigurationError|\sat\s/);
});

test("runtime source contains no developer-specific fallback", async () => {
  const source = await readFile(
    join(repositoryRoot, "src", "runtime", "context-root.ts"),
    "utf8"
  );

  assert.doesNotMatch(source, /rmms-context/i);
  assert.doesNotMatch(source, /DEFAULT_PCW_CONTEXT_ROOT/);
});

test("compiled stdio entrypoint accepts CLI root with precedence over environment", async () => {
  await withServerUsingCli(
    fixtureRoot,
    resolve(fixtureRoot, "ignored-environment-root"),
    async (client) => {
      const response = await callTool<{
        contextRoot: string;
        project: { id: string | null };
      }>(client, "get_project_info");

      assert.equal(response.data.contextRoot, fixtureRoot);
      assert.equal(response.data.project.id, "sample-pcw");
    }
  );
});
