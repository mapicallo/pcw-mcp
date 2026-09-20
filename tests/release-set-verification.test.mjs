import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { zipSync } from "fflate";

import { verifyReleaseSet } from "../scripts/verify-release-set.mjs";

const version = "7.8.9-dev.2";
const coreName = `pcw-mcp-${version}.tgz`;
const bundleName = `PCW-MCP-${version}-PRIVATE-BETA`;
const zipName = `${bundleName}.zip`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verifier = resolve("scripts/verify-release-set.mjs");

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "pcw-release-set-"));
  try {
    const core = Buffer.from("Synthetic Core bytes\n");
    const zip = Buffer.from(zipSync({
      [`${bundleName}/package/${coreName}`]: new Uint8Array(core)
    }, { mtime: new Date(1980, 0, 1) }));
    const manifest = {
      manifestSchemaVersion: 1,
      productId: "pcw-mcp",
      softwareVersion: version,
      channel: "private-beta",
      source: { gitCommit: "a".repeat(40), gitTag: null, dirty: false },
      artifacts: [
        { artifactId: "core-npm-tarball", type: "npm-tarball", fileName: coreName,
          sizeBytes: core.length, sha256: sha256(core) },
        { artifactId: "private-beta-handoff", type: "private-handoff-zip", fileName: zipName,
          sizeBytes: zip.length, sha256: sha256(zip) }
      ]
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const sums = `${sha256(zip)}  ${zipName}\n${sha256(core)}  ${coreName}\n` +
      `${sha256(manifestBytes)}  release-manifest.json\n`;
    await writeFile(join(directory, coreName), core);
    await writeFile(join(directory, zipName), zip);
    await writeFile(join(directory, "release-manifest.json"), manifestBytes);
    await writeFile(join(directory, "SHA256SUMS.txt"), sums);
    await run({ directory, core, zip, manifest });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("verifier checks the complete release set and returns all four hashes", () => fixture(async ({ directory }) => {
  const hashes = await verifyReleaseSet(directory, { requireCleanSource: true });
  assert.deepEqual(Object.keys(hashes).sort(),
    [coreName, zipName, "release-manifest.json", "SHA256SUMS.txt"].sort());
  for (const [name, hash] of Object.entries(hashes)) {
    assert.equal(hash, sha256(await readFile(join(directory, name))));
  }
}));

test("verifier rejects changed artifacts, checksums, and unexpected files", () => fixture(async ({ directory }) => {
  await writeFile(join(directory, "stale.txt"), "stale");
  await assert.rejects(verifyReleaseSet(directory), /unexpected files/);
  await rm(join(directory, "stale.txt"));
  await writeFile(join(directory, "SHA256SUMS.txt"), "invalid\n");
  await assert.rejects(verifyReleaseSet(directory), /SHA256SUMS/);
}));

test("verifier rejects wrong manifest hashes and a different ZIP-embedded Core", () => fixture(async ({ directory, manifest }) => {
  manifest.artifacts[0].sha256 = "0".repeat(64);
  await writeFile(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyReleaseSet(directory), /manifest integrity mismatch/);
  const zip = Buffer.from(zipSync({
    [`${bundleName}/package/${coreName}`]: new TextEncoder().encode("Different Core\n")
  }, { mtime: new Date(1980, 0, 1) }));
  manifest.artifacts[0].sha256 = sha256(await readFile(join(directory, coreName)));
  manifest.artifacts[1].sha256 = sha256(zip);
  manifest.artifacts[1].sizeBytes = zip.length;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, zipName), zip);
  await writeFile(join(directory, "release-manifest.json"), manifestBytes);
  await writeFile(join(directory, "SHA256SUMS.txt"),
    `${sha256(zip)}  ${zipName}\n${manifest.artifacts[0].sha256}  ${coreName}\n` +
    `${sha256(manifestBytes)}  release-manifest.json\n`);
  await assert.rejects(verifyReleaseSet(directory), /ZIP-embedded Core differs/);
}));

test("verifier rejects dirty source when CI requires a clean checkout", () => fixture(async ({ directory, manifest }) => {
  manifest.source.dirty = true;
  await writeFile(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyReleaseSet(directory, { requireCleanSource: true }), /clean Git source/);
}));

test("CLI snapshots and detects a changed second generation", () => fixture(async ({ directory }) => {
  const snapshot = join(tmpdir(), `pcw-release-snapshot-${process.pid}-${Date.now()}.json`);
  try {
    const invoke = (mode) => spawnSync(process.execPath, [
      verifier, "--directory", directory, mode, snapshot, "--require-clean-source"
    ], { encoding: "utf8" });
    assert.equal(invoke("--snapshot").status, 0);
    assert.equal(invoke("--compare").status, 0);
    const hashes = JSON.parse(await readFile(snapshot, "utf8"));
    hashes[coreName] = "0".repeat(64);
    await writeFile(snapshot, `${JSON.stringify(hashes, null, 2)}\n`);
    const result = invoke("--compare");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /differs from verified release set A/);
  } finally {
    await rm(snapshot, { force: true });
  }
}));

test("CLI emits only verified non-binary metadata after matching generations", () => fixture(async ({ directory, manifest }) => {
  const output = await mkdtemp(join(tmpdir(), "pcw-verification-output-"));
  const snapshot = join(output, "snapshot.json");
  const metadataDirectory = join(output, "metadata");
  try {
    const run = (...args) => spawnSync(process.execPath, [
      verifier, "--directory", directory, ...args, "--require-clean-source"
    ], { encoding: "utf8" });
    assert.equal(run("--snapshot", snapshot).status, 0);
    assert.equal(run("--compare", snapshot, "--metadata-directory", metadataDirectory).status, 0);
    const report = JSON.parse(await readFile(join(metadataDirectory, "verification-report.json"), "utf8"));
    assert.equal(report.sourceCommit, manifest.source.gitCommit);
    assert.equal(report.softwareVersion, version);
    assert.equal(report.channel, "private-beta");
    assert.equal(report.packagingNodeVersion, process.version);
    assert.match(report.packagingNpmVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(report.coreTgzSha256, sha256(await readFile(join(directory, coreName))));
    assert.equal(report.handoffZipSha256, sha256(await readFile(join(directory, zipName))));
    assert.equal(report.releaseManifestSha256,
      sha256(await readFile(join(directory, "release-manifest.json"))));
    assert.equal(report.sha256sumsSha256,
      sha256(await readFile(join(directory, "SHA256SUMS.txt"))));
    assert.equal(report.deterministicBuildsMatch, true);
    assert.equal(report.embeddedCoreByteIdentical, true);
    assert.equal(report.verificationSucceeded, true);
    assert.deepEqual((await readdir(metadataDirectory)).sort(),
      ["SHA256SUMS.txt", "release-manifest.json", "verification-report.json"].sort());
    assert.equal(await readFile(join(metadataDirectory, "release-manifest.json"), "utf8"),
      await readFile(join(directory, "release-manifest.json"), "utf8"));
    assert.equal(await readFile(join(metadataDirectory, "SHA256SUMS.txt"), "utf8"),
      await readFile(join(directory, "SHA256SUMS.txt"), "utf8"));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}));
