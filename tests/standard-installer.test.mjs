import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PINNED_INNO_SETUP_VERSION,
  PROTOTYPE_INSTALLER_NAME,
  buildStandardWindowsInstaller,
  parseStandardInstallerArgs
} from "../scripts/build-standard-windows-installer.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installerScript = join(repositoryRoot, "installer", "windows", "pcw-standard.iss");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-standard-installer-"));
  try {
    const runtimeDir = join(root, "Standard Runtime");
    const outputDir = join(root, "Output");
    const iscc = join(root, "Inno Setup 6", "ISCC.exe");
    await mkdir(join(runtimeDir, "metadata"), { recursive: true });
    await mkdir(join(runtimeDir, "runtime"), { recursive: true });
    await mkdir(join(runtimeDir, "bin"), { recursive: true });
    await mkdir(join(runtimeDir, "core", "standard-tools"), { recursive: true });
    await mkdir(join(root, "Inno Setup 6"), { recursive: true });
    await writeFile(join(runtimeDir, "metadata", "standard-runtime.json"), JSON.stringify({
      schemaVersion: 1,
      target: { os: "windows", arch: "x64" },
      core: { version: "0.3.0-beta.1", sha256: "b".repeat(64) }
    }));
    await writeFile(join(runtimeDir, "metadata", "runtime-files.json"), '{"schemaVersion":1,"files":[]}\n');
    await writeFile(join(runtimeDir, "runtime", "node.exe"), "synthetic");
    await writeFile(join(runtimeDir, "bin", "pcw.cmd"), "@echo off\r\n");
    await writeFile(join(runtimeDir, "core", "standard-tools", "standard-setup.mjs"), "// synthetic\n");
    await writeFile(iscc, "synthetic");
    return await run({ root, runtimeDir, outputDir, iscc });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("installer build CLI requires explicit runtime, output and compiler paths", () => {
  assert.deepEqual(parseStandardInstallerArgs([
    "--runtime-dir", "C:\\runtime", "--output-dir", "C:\\output", "--iscc", "C:\\inno\\ISCC.exe"
  ]), { runtimeDir: "C:\\runtime", outputDir: "C:\\output", iscc: "C:\\inno\\ISCC.exe" });
  assert.throws(() => parseStandardInstallerArgs(["--runtime-dir", "C:\\runtime"]), /outputDir is required/);
  assert.throws(() => parseStandardInstallerArgs([
    "--runtime-dir", "relative", "--output-dir", "C:\\output", "--iscc", "C:\\inno\\ISCC.exe"
  ]), /runtimeDir must be an absolute path/);
});

test("Inno skeleton is per-user, consumes a prebuilt runtime and preserves user data", async () => {
  const source = await readFile(installerScript, "utf8");
  assert.match(source, /PrivilegesRequired=lowest/u);
  assert.match(source, /DefaultDirName=\{localappdata\}\\Programs\\AI4Context\\PCW/u);
  assert.match(source, /Source: "\{#RuntimeDir\}\\\*"/u);
  assert.match(source, /PCW-Setup-0\.3\.0-beta\.1-prototype/u);
  assert.match(source, /standard-setup\.mjs/u);
  assert.match(source, /--all-owned/u);
  assert.match(source, /context roots and recovery backups will be preserved/iu);
  assert.doesNotMatch(source, /npm\s+(ci|install)/iu);
  assert.doesNotMatch(source, /https?:\/\//iu);
  assert.doesNotMatch(source, /ChangesEnvironment|PATH=/iu);
  assert.doesNotMatch(source, /DestDir:.*context/iu);
  assert.doesNotMatch(source, /pcw\.yml";\s*DestDir/iu);
});

test("installer helper pins Inno and derives metadata from the explicit runtime", () =>
  fixture(async ({ root, runtimeDir, outputDir, iscc }) => {
    let capturedMetadata;
    const execute = (_command, args) => {
      if (args[0] === "/?") return `Inno Setup 6 Command-Line Compiler version ${PINNED_INNO_SETUP_VERSION}`;
      const metadataArg = args.find((arg) => arg.startsWith("/DInstallerMetadataFile="));
      capturedMetadata = JSON.parse(readFileSync(metadataArg.slice(metadataArg.indexOf("=") + 1), "utf8"));
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, PROTOTYPE_INSTALLER_NAME), "synthetic installer");
      return "compiled";
    };
    const result = await buildStandardWindowsInstaller({ runtimeDir, outputDir, iscc, execute });
    assert.equal(result.compilerVersion, PINNED_INNO_SETUP_VERSION);
    assert.equal(result.installer, join(outputDir, PROTOTYPE_INSTALLER_NAME));
    assert.deepEqual(capturedMetadata, {
      schemaVersion: 1,
      productId: "pcw-standard-windows-installer-prototype",
      softwareVersion: "0.3.0-beta.1",
      coreTgzSha256: "b".repeat(64),
      runtimeSchemaVersion: 1,
      target: { os: "windows", arch: "x64" },
      releaseGrade: false,
      signed: false
    });
    assert.equal(JSON.stringify(capturedMetadata).includes(root), false);
  }));

test("installer build refuses an unpinned Inno compiler", () =>
  fixture(async ({ root, runtimeDir, outputDir, iscc }) => {
    await assert.rejects(buildStandardWindowsInstaller({
      runtimeDir,
      outputDir,
      iscc,
      execute: () => "Inno Setup 6 Command-Line Compiler version 6.5.4"
    }), /6\.4\.3 is required/);
  }));

test("installer output remains outside release manifests and publication workflows", async () => {
  const files = await Promise.all([
    readFile(join(repositoryRoot, "scripts", "build-release.mjs"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "release-build.yml"), "utf8")
  ]);
  assert.equal(files.some((text) => text.includes(PROTOTYPE_INSTALLER_NAME)), false);
  assert.equal(files.some((text) => text.includes("standard-windows-installer")), false);
});
