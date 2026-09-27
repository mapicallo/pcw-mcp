import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assembleStandardWindowsRuntime,
  parseStandardRuntimeArgs,
  sha256File
} from "../scripts/standard-runtime.mjs";
import { runDoctor } from "../scripts/standard-runtime-doctor.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const doctorSource = join(repositoryRoot, "scripts", "standard-runtime-doctor.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function createFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-standard-runtime-test-"));
  const source = join(root, "source");
  const packageJson = {
    name: "pcw-mcp",
    version: "9.8.7-test.1",
    type: "module",
    main: "dist/server.js",
    dependencies: { "synthetic-runtime-dependency": "1.0.0" }
  };
  const lock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { ...packageJson } }
  };
  try {
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify(packageJson));
    await writeFile(join(source, "dist", "server.js"), `
import { appendFileSync } from "node:fs";
if (process.env.PCW_TEST_ARGS_FILE) {
  appendFileSync(process.env.PCW_TEST_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
  process.exit(0);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines.filter(Boolean)) {
    const request = JSON.parse(line);
    if (request.id === 1) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: 1,
        result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "synthetic", version: "1" } }
      }) + "\\n");
    }
    if (request.id === 2) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }) + "\\n");
    }
  }
});
`);
    const archiveDirectory = join(root, "archive");
    await mkdir(archiveDirectory);
    const output = execFileSync(process.execPath, [
      npmCli, "pack", "--json", "--pack-destination", archiveDirectory
    ], { cwd: source, encoding: "utf8" });
    const [{ filename }] = JSON.parse(output);
    const coreTgz = join(archiveDirectory, filename);
    const packageLock = join(root, "package-lock.json");
    await writeFile(packageLock, JSON.stringify(lock));
    const nodeRuntime = join(root, "node-input");
    await mkdir(nodeRuntime);
    await copyFile(process.execPath, join(nodeRuntime, "node.exe"));
    const installDependencies = async ({ coreDirectory }) => {
      const moduleRoot = join(coreDirectory, "node_modules", "synthetic-runtime-dependency");
      await mkdir(moduleRoot, { recursive: true });
      await writeFile(join(moduleRoot, "package.json"), '{"name":"synthetic-runtime-dependency","version":"1.0.0"}');
    };
    const verifyDependencies = async ({ coreDirectory }) => {
      await access(join(coreDirectory, "node_modules", "synthetic-runtime-dependency", "package.json"));
    };
    return await run({
      root, coreTgz, packageLock, nodeRuntime, installDependencies, verifyDependencies
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildOptions(fixture, output) {
  return {
    ...fixture,
    output,
    npmCli,
    doctorSource,
    expectedNodeVersion: process.version,
    installDependencies: fixture.installDependencies,
    verifyDependencies: fixture.verifyDependencies
  };
}

test("standard runtime CLI requires explicit Core, Node and output inputs", () => {
  assert.deepEqual(parseStandardRuntimeArgs([
    "--core-tgz", "a", "--node-runtime", "b", "--output", "c"
  ]), { coreTgz: "a", nodeRuntime: "b", output: "c" });
  assert.throws(() => parseStandardRuntimeArgs(["--core-tgz"]), /Invalid or incomplete/);
  assert.rejects(
    assembleStandardWindowsRuntime({}),
    /coreTgz is required/
  );
});

test("runtime preserves canonical Core bytes and deterministic provenance", () =>
  createFixture(async (fixture) => {
    const outputA = join(fixture.root, "runtime-a");
    const outputB = join(fixture.root, "runtime-b");
    await assembleStandardWindowsRuntime(buildOptions(fixture, outputA));
    await assembleStandardWindowsRuntime(buildOptions(fixture, outputB));
    const retainedA = join(outputA, "package", "pcw-mcp-9.8.7-test.1.tgz");
    const retainedB = join(outputB, "package", "pcw-mcp-9.8.7-test.1.tgz");
    assert.equal(await sha256File(fixture.coreTgz), await sha256File(retainedA));
    assert.equal(await sha256File(retainedA), await sha256File(retainedB));
    const metadataA = await readFile(join(outputA, "metadata", "standard-runtime.json"), "utf8");
    const metadataB = await readFile(join(outputB, "metadata", "standard-runtime.json"), "utf8");
    assert.equal(metadataA, metadataB);
    assert.equal(metadataA.includes(fixture.root), false);
    const metadata = JSON.parse(metadataA);
    assert.equal(metadata.core.version, "9.8.7-test.1");
    assert.equal(metadata.target.os, "windows");
    assert.equal(metadata.target.arch, "x64");
    assert.equal(metadata.core.sha256, hash(await readFile(fixture.coreTgz)));
    assert.equal(metadata.core.packageLockSha256, hash(await readFile(fixture.packageLock)));
    assert.deepEqual(await readdir(outputA), ["bin", "core", "metadata", "package", "runtime", "tools"]);
  }));

test("incompatible package lock fails without replacing an existing runtime", () =>
  createFixture(async (fixture) => {
    const output = join(fixture.root, "runtime");
    await assembleStandardWindowsRuntime(buildOptions(fixture, output));
    const marker = join(output, "marker.txt");
    await writeFile(marker, "preserved");
    const lock = JSON.parse(await readFile(fixture.packageLock, "utf8"));
    lock.packages[""].version = "0.0.0";
    await writeFile(fixture.packageLock, JSON.stringify(lock));
    await assert.rejects(
      assembleStandardWindowsRuntime(buildOptions(fixture, output)),
      /version does not match/
    );
    assert.equal(await readFile(marker, "utf8"), "preserved");
  }));

test("doctor reports healthy runtime and leaves an existing context unchanged", () =>
  createFixture(async (fixture) => {
    const runtimeRoot = join(fixture.root, "runtime");
    await assembleStandardWindowsRuntime(buildOptions(fixture, runtimeRoot));
    const contextRoot = join(fixture.root, "existing-context");
    await mkdir(contextRoot);
    await writeFile(join(contextRoot, "pcw.yml"), "version: 1\nworkstreams: {}\n");
    const before = await readFile(join(contextRoot, "pcw.yml"));
    const results = await runDoctor({
      runtimeRoot,
      contextRoot,
      dependencyProbe: async () => {},
      configLoader: async (_runtime, context) => {
        const yaml = await readFile(join(context, "pcw.yml"), "utf8");
        if (!yaml.includes("version: 1")) throw new Error("invalid config");
      }
    });
    assert.equal(results.every(({ ok }) => ok), true);
    assert.deepEqual(await readFile(join(contextRoot, "pcw.yml")), before);
  }));

test("doctor detects corrupt runtime and invalid or missing contexts", () =>
  createFixture(async (fixture) => {
    const runtimeRoot = join(fixture.root, "runtime");
    await assembleStandardWindowsRuntime(buildOptions(fixture, runtimeRoot));
    const contextRoot = join(fixture.root, "context");
    await mkdir(contextRoot);
    await writeFile(join(contextRoot, "pcw.yml"), "invalid: true\n");
    await rm(join(runtimeRoot, "runtime", "node.exe"));
    await writeFile(join(runtimeRoot, "package", "pcw-mcp-9.8.7-test.1.tgz"), "corrupt");
    const corePackagePath = join(runtimeRoot, "core", "package.json");
    const corePackage = JSON.parse(await readFile(corePackagePath, "utf8"));
    corePackage.version = "0.0.0";
    await writeFile(corePackagePath, JSON.stringify(corePackage));
    const results = await runDoctor({
      runtimeRoot,
      contextRoot,
      dependencyProbe: async () => { throw new Error("dependencies unavailable"); },
      configLoader: async () => { throw new Error("invalid pcw.yml"); },
      mcpProbe: async () => { throw new Error("startup unavailable"); }
    });
    for (const label of [
      "Portable Node", "Canonical Core integrity", "Expanded Core",
      "Production dependencies", "pcw.yml", "MCP startup"
    ]) {
      assert.equal(results.find((result) => result.label === label)?.ok, false, label);
    }
    const missing = await runDoctor({
      runtimeRoot,
      contextRoot: join(fixture.root, "missing"),
      dependencyProbe: async () => {},
      configLoader: async () => {},
      mcpProbe: async () => {}
    });
    assert.equal(missing.find(({ label }) => label === "Context root")?.ok, false);
  }));

test("Windows launcher forwards difficult paths, ignores CWD and keeps stdout clean", {
  skip: process.platform !== "win32"
}, () => createFixture(async (fixture) => {
  const runtimeRoot = join(fixture.root, "Runtime With Spaces");
  await assembleStandardWindowsRuntime(buildOptions(fixture, runtimeRoot));
  const argsFile = join(fixture.root, "args.txt");
  const contextPaths = [
    join(fixture.root, "space path"),
    join(fixture.root, "parentheses (test)"),
    join(fixture.root, "ampersand & test"),
    join(fixture.root, "Unicode-\u00f1")
  ];
  const launcher = join(runtimeRoot, "bin", "pcw.cmd");
  for (const contextPath of contextPaths) {
    const { stdout, stderr } = await execFileAsync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "call", launcher, "--context-root", contextPath],
      {
        cwd: tmpdir(),
        env: { ...process.env, PCW_TEST_ARGS_FILE: argsFile },
        windowsHide: true
      }
    );
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  }
  const forwarded = (await readFile(argsFile, "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(forwarded, contextPaths.map((path) => ["--context-root", path]));
}));
