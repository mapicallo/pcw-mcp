import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRelease } from "../scripts/build-release.mjs";
import {
  CORE_TRANSPORT_METADATA_FILE,
  createCoreTransport,
  createStandardTransport,
  STANDARD_TRANSPORT_METADATA_FILE,
  STANDARD_VERIFICATION_FILE,
  verifyCoreTransport,
  verifyStandardTransport
} from "../scripts/release-transport.mjs";

const version = "0.3.0-beta.2-dev.0";
const sourceCommit = "a".repeat(40);
const releaseInvocation = "test-run-42-1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-release-transport-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "pcw-mcp", version }));
    const coreDirectory = join(root, "core-transport");
    const core = await createCoreTransport({
      repositoryRoot: root,
      outputDirectory: coreDirectory,
      sourceCommit,
      releaseInvocation,
      packCore: async (_repositoryRoot, destination) => {
        const path = join(destination, `pcw-mcp-${version}.tgz`);
        await writeFile(path, "synthetic canonical Core\n");
        return path;
      }
    });
    const buildDirectory = join(root, "builds");
    await mkdir(buildDirectory);
    const installerA = join(buildDirectory, `PCW-Setup-${version}-prototype.exe`);
    const installerB = join(buildDirectory, "independent-b.exe");
    const installerBytes = Buffer.from("synthetic installer A and B\n");
    await writeFile(installerA, installerBytes);
    await writeFile(installerB, installerBytes);
    const buildReport = (installer) => ({
      ok: true,
      installer,
      prototype: true,
      softwareVersion: version,
      coreTgzSha256: core.metadata.sha256,
      inputFingerprint: sha256("synthetic pre-Inno inputs"),
      installerSha256: sha256(installerBytes)
    });
    const buildAPath = join(buildDirectory, "a.json");
    const buildBPath = join(buildDirectory, "b.json");
    const reproducibilityPath = join(buildDirectory, "reproducibility.json");
    const lifecyclePath = join(buildDirectory, "lifecycle.json");
    await writeFile(buildAPath, JSON.stringify(buildReport(installerA)));
    await writeFile(buildBPath, JSON.stringify(buildReport(installerB)));
    await writeFile(reproducibilityPath, JSON.stringify({
      schemaVersion: 1,
      deterministicBuildsMatch: true,
      preInnoInputSha256: sha256("synthetic pre-Inno inputs"),
      installerSha256: sha256(installerBytes),
      coreTgzSha256: core.metadata.sha256,
      softwareVersion: version,
      sizeBytes: installerBytes.length
    }));
    await writeFile(lifecyclePath, JSON.stringify({
      installerSha256: sha256(installerBytes),
      passed: true,
      mcpToolCount: 16,
      workstreamCreated: true,
      realClientConfigUsed: false
    }));
    const standardDirectory = join(root, "standard-transport");
    const inputs = {
      coreTgz: core.coreTgz,
      coreMetadataPath: core.metadataPath,
      buildAPath,
      buildBPath,
      reproducibilityPath,
      lifecyclePath,
      outputDirectory: standardDirectory,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation,
      contextPreserved: true
    };
    await run({ root, core, coreDirectory, standardDirectory, inputs, installerBytes,
      buildAPath, buildBPath, reproducibilityPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("canonical Core survives artifact-style copy with exact bytes and trusted metadata", () =>
  fixture(async ({ root, core, coreDirectory }) => {
    const downloaded = join(root, "downloaded-core");
    await cp(coreDirectory, downloaded, { recursive: true });
    const verified = await verifyCoreTransport({
      coreTgz: join(downloaded, core.metadata.fileName),
      metadataPath: join(downloaded, CORE_TRANSPORT_METADATA_FILE),
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation,
      expectedFileName: core.metadata.fileName
    });
    assert.deepEqual(verified.bytes, await readFile(core.coreTgz));
  }));

test("Core and Standard transports reject unexpected artifact contents", () =>
  fixture(async ({ core, coreDirectory, standardDirectory, inputs }) => {
    await writeFile(join(coreDirectory, "unexpected.log"), "not transport data");
    await assert.rejects(verifyCoreTransport({
      coreTgz: core.coreTgz,
      metadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation,
      expectedFileName: core.metadata.fileName
    }), /unexpected files/);
    await rm(join(coreDirectory, "unexpected.log"));
    await createStandardTransport(inputs);
    await writeFile(join(standardDirectory, "expanded-runtime.txt"), "forbidden extra");
    await assert.rejects(verifyStandardTransport({
      directory: standardDirectory,
      coreTgz: core.coreTgz,
      coreMetadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation
    }), /unexpected files/);
  }));

test("Core transport rejects changed bytes, wrong SHA, version, commit, and filename", () =>
  fixture(async ({ core }) => {
    const expected = {
      coreTgz: core.coreTgz,
      metadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation,
      expectedFileName: core.metadata.fileName
    };
    await writeFile(core.coreTgz, "changed Core byte");
    await assert.rejects(verifyCoreTransport(expected), /bytes do not match/);
    await writeFile(core.coreTgz, "synthetic canonical Core\n");
    const metadata = JSON.parse(await readFile(core.metadataPath, "utf8"));
    metadata.sha256 = "0".repeat(64);
    await writeFile(core.metadataPath, JSON.stringify(metadata));
    await assert.rejects(verifyCoreTransport(expected), /bytes do not match/);
    metadata.sha256 = core.metadata.sha256;
    await writeFile(core.metadataPath, JSON.stringify(metadata));
    await assert.rejects(verifyCoreTransport({ ...expected, expectedSoftwareVersion: "9.9.9" }), /softwareVersion mismatch/);
    await assert.rejects(verifyCoreTransport({ ...expected, expectedSourceCommit: "b".repeat(40) }), /sourceCommit mismatch/);
    await assert.rejects(verifyCoreTransport({ ...expected, expectedFileName: "other.tgz" }), /filename mismatch/);
  }));

test("Standard transport proves canonical Core identity and exact lifecycle-tested A bytes", () =>
  fixture(async ({ root, core, standardDirectory, inputs, installerBytes }) => {
    const created = await createStandardTransport(inputs);
    assert.equal(created.metadata.coreSha256, core.metadata.sha256);
    assert.equal(created.metadata.sha256, sha256(installerBytes));
    const downloaded = join(root, "downloaded-standard");
    await cp(standardDirectory, downloaded, { recursive: true });
    const verified = await verifyStandardTransport({
      directory: downloaded,
      coreTgz: core.coreTgz,
      coreMetadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation
    });
    assert.deepEqual(await readFile(verified.installerPath), installerBytes);
    assert.equal(verified.verification.lifecycle.contextPreserved, true);
  }));

test("runtime/build evidence with a different Core is rejected before Standard transport", () =>
  fixture(async ({ inputs, buildAPath, reproducibilityPath }) => {
    const build = JSON.parse(await readFile(buildAPath, "utf8"));
    build.coreTgzSha256 = "1".repeat(64);
    await writeFile(buildAPath, JSON.stringify(build));
    await assert.rejects(createStandardTransport(inputs), /canonical Core/);
    build.coreTgzSha256 = inputs.expectedSourceCommit.padEnd(64, "0").slice(0, 64);
    const reproducibility = JSON.parse(await readFile(reproducibilityPath, "utf8"));
    reproducibility.coreTgzSha256 = "2".repeat(64);
    await writeFile(reproducibilityPath, JSON.stringify(reproducibility));
    await assert.rejects(createStandardTransport(inputs), /canonical Core/);
  }));

test("returned installer byte changes and finalization substitution are rejected", () =>
  fixture(async ({ core, standardDirectory, inputs }) => {
    const created = await createStandardTransport(inputs);
    await writeFile(created.installerPath, "substituted EXE B");
    await assert.rejects(verifyStandardTransport({
      directory: standardDirectory,
      coreTgz: core.coreTgz,
      coreMetadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation
    }), /installer bytes/);
  }));

test("installer evidence Core, commit, and release invocation mismatches are rejected", () =>
  fixture(async ({ core, standardDirectory, inputs }) => {
    const created = await createStandardTransport(inputs);
    const verification = JSON.parse(await readFile(created.verificationPath, "utf8"));
    verification.sourceCommit = "b".repeat(40);
    const verificationBytes = Buffer.from(`${JSON.stringify(verification, null, 2)}\n`);
    await writeFile(created.verificationPath, verificationBytes);
    const metadataPath = join(standardDirectory, STANDARD_TRANSPORT_METADATA_FILE);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.verificationSha256 = sha256(verificationBytes);
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(verifyStandardTransport({
      directory: standardDirectory,
      coreTgz: core.coreTgz,
      coreMetadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation
    }), /evidence provenance/);
    verification.sourceCommit = sourceCommit;
    verification.coreTgzSha256 = "3".repeat(64);
    const changed = Buffer.from(`${JSON.stringify(verification, null, 2)}\n`);
    await writeFile(join(standardDirectory, STANDARD_VERIFICATION_FILE), changed);
    metadata.verificationSha256 = sha256(changed);
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(verifyStandardTransport({
      directory: standardDirectory,
      coreTgz: core.coreTgz,
      coreMetadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation
    }), /evidence provenance/);
    verification.coreTgzSha256 = core.metadata.sha256;
    verification.releaseInvocation = "different-release-invocation";
    const changedInvocation = Buffer.from(`${JSON.stringify(verification, null, 2)}\n`);
    await writeFile(join(standardDirectory, STANDARD_VERIFICATION_FILE), changedInvocation);
    metadata.verificationSha256 = sha256(changedInvocation);
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(verifyStandardTransport({
      directory: standardDirectory,
      coreTgz: core.coreTgz,
      coreMetadataPath: core.metadataPath,
      expectedSoftwareVersion: version,
      expectedSourceCommit: sourceCommit,
      expectedReleaseInvocation: releaseInvocation
    }), /evidence provenance/);
  }));

test("release-grade finalization refuses source repack and requires transferred Core", () =>
  fixture(async ({ root }) => {
    let packed = false;
    await assert.rejects(buildRelease({
      repositoryRoot: root,
      channel: "private-beta",
      releaseGrade: true,
      releasedAt: "2026-09-28T00:00:00.000Z",
      packCore: async () => { packed = true; }
    }), /transferred canonical Core/);
    assert.equal(packed, false);
  }));
