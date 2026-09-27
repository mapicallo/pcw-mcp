import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PINNED_INNO_SETUP_VERSION,
  officialInstallerName,
  prototypeInstallerName,
  buildStandardWindowsInstaller,
  parseStandardInstallerArgs
} from "../scripts/build-standard-windows-installer.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const installerScript = join(repositoryRoot, "installer", "windows", "pcw-standard.iss");
const developmentVersion = "0.3.0-beta.2-dev.0";
const expectedPrototypeInstallerName = prototypeInstallerName(developmentVersion);

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
      core: { version: developmentVersion, sha256: "b".repeat(64) }
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
  const runtimePath = resolve("runtime");
  const outputPath = resolve("output");
  const compilerPath = resolve("Inno Setup 6", "ISCC.exe");
  assert.deepEqual(parseStandardInstallerArgs([
    "--runtime-dir", runtimePath, "--output-dir", outputPath, "--iscc", compilerPath
  ]), { runtimeDir: runtimePath, outputDir: outputPath, iscc: compilerPath, mode: "release" });
  assert.equal(parseStandardInstallerArgs([
    "--runtime-dir", runtimePath, "--output-dir", outputPath, "--iscc", compilerPath,
    "--mode", "engineering"
  ]).mode, "engineering");
  assert.throws(() => parseStandardInstallerArgs(["--runtime-dir", runtimePath]), /outputDir is required/);
  assert.throws(() => parseStandardInstallerArgs([
    "--runtime-dir", "relative", "--output-dir", outputPath, "--iscc", compilerPath
  ]), /runtimeDir must be an absolute path/);
  assert.throws(() => parseStandardInstallerArgs([
    "--runtime-dir", runtimePath, "--output-dir", outputPath, "--iscc", compilerPath,
    "--mode", "production-ish"
  ]), /mode must be release or engineering/);
});

test("Inno skeleton is per-user, consumes a prebuilt runtime and preserves user data", async () => {
  const source = await readFile(installerScript, "utf8");
  assert.match(source, /PrivilegesRequired=lowest/u);
  assert.match(source, /DefaultDirName=\{localappdata\}\\Programs\\AI4Context\\PCW/u);
  assert.match(source, /Source: "\{#RuntimeDir\}\\\*"/u);
  assert.match(source, /OutputBaseFilename=PCW-Setup-\{#AppVersion\}\{#OutputSuffix\}/u);
  assert.match(source, /#define OutputSuffix "-prototype"/u);
  assert.match(source, /#define OutputSuffix ""/u);
  assert.match(source, /core\\standard-tools\\standard-setup\.mjs/u);
  assert.match(source, /Create a new empty PCW context/u);
  assert.match(source, /Use an existing PCW context/u);
  assert.match(source, /RunSetupHelper\('init-context'/u);
  assert.match(source, /RunSetupHelper\('validate-context'/u);
  assert.match(source, /\{param:PCWContext\|\}/u);
  assert.match(source, /\{param:PCWContextMode\|new\}/u);
  assert.match(source, /\{param:PCWStateRoot\|\}/u);
  assert.match(source, /\{param:PCWHomeDirectory\|\}/u);
  assert.match(source, /#ifdef PcwEngineeringBuild[\s\S]*\{param:PCWStateRoot\|\}/u);
  assert.match(source, /#ifdef PcwEngineeringBuild[\s\S]*\{param:PCWHomeDirectory\|\}/u);
  assert.match(source, /#ifdef PcwEngineeringBuild[\s\S]*\{param:PCWContext\|\}/u);
  assert.match(source, /#ifdef PcwEngineeringBuild[\s\S]*\{param:PCWContextMode\|new\}/u);
  assert.match(source, /ResultText := UTF8Decode\(RawResultText\)/u);
  assert.match(source, /\{%USERPROFILE\}\\PCW\\My-PCW-Context/u);
  assert.match(source, /Name: "\{code:ContextParent\}"; Flags: uninsneveruninstall/u);
  assert.match(source, /--all-owned/u);
  assert.match(source, /UninstallSilent/u);
  assert.match(source, /\{param:PCWRemoveOwned\|no\}/u);
  assert.match(source, /context roots and recovery backups will be preserved/iu);
  assert.doesNotMatch(source, /npm\s+(ci|install)/iu);
  assert.doesNotMatch(source, /https?:\/\//iu);
  assert.doesNotMatch(source, /ChangesEnvironment|PATH=/iu);
  assert.doesNotMatch(source, /DestDir:.*context/iu);
  assert.doesNotMatch(source, /pcw\.yml";\s*DestDir/iu);
  assert.doesNotMatch(source, /workstreams\s*:/iu);
  assert.doesNotMatch(source, /version\s*:\s*1/iu);
});

test("installer helper pins Inno and derives metadata from the explicit runtime", () =>
  fixture(async ({ root, runtimeDir, outputDir, iscc }) => {
    let capturedMetadata;
    const execute = (_command, args) => {
      if (args.some((arg) => arg.endsWith("version-probe.iss"))) {
        return `Compiler engine version: Inno Setup ${PINNED_INNO_SETUP_VERSION}`;
      }
      const metadataArg = args.find((arg) => arg.startsWith("/DInstallerMetadataFile="));
      capturedMetadata = JSON.parse(readFileSync(metadataArg.slice(metadataArg.indexOf("=") + 1), "utf8"));
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, expectedPrototypeInstallerName), "synthetic installer");
      return "compiled";
    };
    const result = await buildStandardWindowsInstaller({
      runtimeDir, outputDir, iscc, mode: "engineering", execute
    });
    assert.equal(result.compilerVersion, PINNED_INNO_SETUP_VERSION);
    assert.equal(result.installer, join(outputDir, expectedPrototypeInstallerName));
    assert.deepEqual(capturedMetadata, {
      schemaVersion: 1,
      productId: "pcw-standard-windows-installer-prototype",
      softwareVersion: developmentVersion,
      coreTgzSha256: "b".repeat(64),
      runtimeSchemaVersion: 1,
      target: { os: "windows", arch: "x64" },
      releaseGrade: false,
      signed: false
    });
    assert.equal(JSON.stringify(capturedMetadata).includes(root), false);
  }));

test("synthetic location overrides require an explicit engineering build", () =>
  fixture(async ({ runtimeDir, outputDir, iscc }) => {
    const compileCalls = [];
    const execute = (_command, args) => {
      if (args.some((arg) => arg.endsWith("version-probe.iss"))) {
        return `Compiler engine version: Inno Setup ${PINNED_INNO_SETUP_VERSION}`;
      }
      compileCalls.push(args);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, expectedPrototypeInstallerName), "synthetic installer");
      return "compiled";
    };

    await buildStandardWindowsInstaller({
      runtimeDir, outputDir, iscc, mode: "engineering", execute
    });
    assert.equal(compileCalls[0].includes("/DPcwEngineeringBuild=1"), true);
  }));

test("official mode rejects development identity and uses an unsuffixed release filename", () =>
  fixture(async ({ runtimeDir, outputDir, iscc }) => {
    await assert.rejects(buildStandardWindowsInstaller({
      runtimeDir,
      outputDir,
      iscc,
      mode: "release",
      execute: (_command, args) => args.some((arg) => arg.endsWith("version-probe.iss"))
        ? `Compiler engine version: Inno Setup ${PINNED_INNO_SETUP_VERSION}`
        : "compiled"
    }), /refuses development software versions/);
    assert.equal(officialInstallerName("0.3.0-beta.2"), "PCW-Setup-0.3.0-beta.2.exe");
    assert.equal(officialInstallerName("0.3.0-beta.2").includes("prototype"), false);
  }));

test("official mode enforces pinned Node archive and npm identities", () =>
  fixture(async ({ runtimeDir, outputDir, iscc }) => {
    const metadataPath = join(runtimeDir, "metadata", "standard-runtime.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.core.version = "0.3.0-beta.2";
    metadata.node = {
      version: "22.23.3",
      inputType: "zip",
      inputSha256: "0".repeat(64)
    };
    metadata.build = { npmVersion: "11.4.2" };
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(buildStandardWindowsInstaller({
      runtimeDir,
      outputDir,
      iscc,
      mode: "release",
      execute: () => `Compiler engine version: Inno Setup ${PINNED_INNO_SETUP_VERSION}`
    }), /pinned Node\/npm runtime inputs/);
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

test("installer enters release tooling only through explicit verification and is not uploaded by dev CI", async () => {
  const files = await Promise.all([
    readFile(join(repositoryRoot, "scripts", "build-release.mjs"), "utf8"),
    readFile(join(repositoryRoot, ".github", "workflows", "standard-windows.yml"), "utf8")
  ]);
  assert.match(files[0], /standardWindowsVerification/u);
  assert.match(files[0], /validateStandardInstallerArtifact/u);
  assert.doesNotMatch(files[1], /actions\/upload-artifact/iu);
  assert.doesNotMatch(files[1], /PCW-Setup-.*\.exe.*upload/iu);
});
