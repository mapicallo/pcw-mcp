import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStandardInstallerVerification,
  PINNED_INNO_INSTALLER_SHA256,
  STANDARD_WINDOWS_ARTIFACT_ID,
  STANDARD_WINDOWS_ARTIFACT_TYPE,
  validateStandardInstallerArtifact
} from "../scripts/standard-installer-release.mjs";

const version = "0.3.0-beta.2";
const fileName = `PCW-Setup-${version}.exe`;
const sourceCommit = "a".repeat(40);
const releaseInvocation = "test-release-1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-standard-release-"));
  try {
    const installer = join(root, fileName);
    const bytes = Buffer.from("synthetic unsigned installer");
    await writeFile(installer, bytes);
    const installerSha256 = sha256(bytes);
    const coreTgzSha256 = sha256("synthetic canonical Core");
    const verification = createStandardInstallerVerification({
      softwareVersion: version,
      sourceCommit,
      releaseInvocation,
      fileName,
      coreTgzSha256,
      preInnoInputSha256: sha256("stable pre-Inno inputs"),
      buildASha256: installerSha256,
      buildBSha256: installerSha256,
      lifecycle: {
        installerSha256,
        passed: true,
        mcpToolCount: 16,
        workstreamCreated: true,
        contextPreserved: true,
        realClientConfigUsed: false
      }
    });
    await run({ installer, installerSha256, coreTgzSha256, verification });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Standard artifact descriptor is explicit windows/x64 with bundled Node metadata", () =>
  fixture(async ({ installer, coreTgzSha256, verification }) => {
    const descriptor = await validateStandardInstallerArtifact({
      installerPath: installer,
      verification,
      softwareVersion: version,
      sourceCommit,
      releaseInvocation,
      coreTgzSha256,
      releaseGrade: true
    });
    assert.deepEqual(descriptor, {
      artifactId: STANDARD_WINDOWS_ARTIFACT_ID,
      type: STANDARD_WINDOWS_ARTIFACT_TYPE,
      file: fileName,
      target: { os: "windows", arch: "x64" },
      runtime: { node: "22.23.3" }
    });
    assert.equal(verification.innoInstallerSha256, PINNED_INNO_INSTALLER_SHA256);
    assert.equal(verification.signed, false);
  }));

test("Standard artifact gate rejects a different Core or different lifecycle bytes", () =>
  fixture(async ({ installer, coreTgzSha256, verification }) => {
    await assert.rejects(validateStandardInstallerArtifact({
      installerPath: installer,
      verification,
      softwareVersion: version,
      sourceCommit,
      releaseInvocation,
      coreTgzSha256: "0".repeat(64),
      releaseGrade: true
    }), /Core SHA/);
    const changed = structuredClone(verification);
    changed.lifecycle.installerSha256 = "1".repeat(64);
    await assert.rejects(validateStandardInstallerArtifact({
      installerPath: installer,
      verification: changed,
      softwareVersion: version,
      sourceCommit,
      releaseInvocation,
      coreTgzSha256,
      releaseGrade: true
    }), /differ/);
  }));

test("release-grade Standard gate rejects development versions even with matching evidence", () =>
  fixture(async ({ installer, coreTgzSha256, verification }) => {
    const development = structuredClone(verification);
    development.softwareVersion = "0.3.0-beta.2-dev.0";
    development.fileName = "PCW-Setup-0.3.0-beta.2-dev.0.exe";
    const developmentInstaller = join(tmpdir(), development.fileName);
    await writeFile(developmentInstaller, await readFile(installer));
    try {
      await assert.rejects(validateStandardInstallerArtifact({
        installerPath: developmentInstaller,
        verification: development,
        softwareVersion: development.softwareVersion,
        sourceCommit,
        releaseInvocation,
        coreTgzSha256,
        releaseGrade: true
      }), /refuses development/);
    } finally {
      await rm(developmentInstaller, { force: true });
    }
  }));

test("verification creation refuses unequal unsigned installer builds", () => {
  assert.throws(() => createStandardInstallerVerification({
    softwareVersion: version,
    sourceCommit,
    releaseInvocation,
    fileName,
    coreTgzSha256: "a".repeat(64),
    preInnoInputSha256: "b".repeat(64),
    buildASha256: "c".repeat(64),
    buildBSha256: "d".repeat(64),
    lifecycle: {
      installerSha256: "c".repeat(64),
      passed: true,
      mcpToolCount: 16,
      workstreamCreated: true,
      contextPreserved: true,
      realClientConfigUsed: false
    }
  }), /not byte-identical/);
});
