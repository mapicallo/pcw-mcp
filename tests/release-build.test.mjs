import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { unzipSync, zipSync } from "fflate";

import { buildRelease, checksumText, parseReleaseBuildArgs } from "../scripts/build-release.mjs";
import { createStandardInstallerVerification } from "../scripts/standard-installer-release.mjs";

const version = "7.8.9-beta.2";
const zipName = `PCW-MCP-${version}-PRIVATE-BETA.zip`;
const tarballName = `pcw-mcp-${version}.tgz`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-release-build-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "pcw-mcp", version, engines: { node: ">=22.9.0" }
    }));
    await writeFile(join(root, ".gitignore"), "artifacts/\n");
    git(root, "init", "-q");
    git(root, "add", "package.json", ".gitignore");
    git(root, "-c", "user.name=PCW Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "synthetic baseline");
    const packCore = async (_repositoryRoot, destination) => {
      const corePath = join(destination, tarballName);
      await writeFile(corePath, "Synthetic Core bytes\n");
      return corePath;
    };
    const packagePrivateBeta = async (_repositoryRoot, corePath) => {
      const output = join(root, "artifacts", "private-beta", version);
      await mkdir(output, { recursive: true });
      const zip = Buffer.from(zipSync({
        [`${zipName.slice(0, -4)}/package/${tarballName}`]:
          new Uint8Array(await readFile(corePath))
      }, { mtime: new Date(1980, 0, 1) }));
      await writeFile(join(output, zipName), zip);
      await writeFile(join(output, `${zipName}.sha256`), `${hash(zip)}  ${zipName}\n`);
    };
    const transferredCore = async () => {
      const directory = join(root, "artifacts", "transported-core");
      await mkdir(directory, { recursive: true });
      const coreTgz = join(directory, tarballName);
      await writeFile(coreTgz, "Synthetic Core bytes\n");
      const metadata = {
        schemaVersion: 1,
        transportType: "pcw-core",
        softwareVersion: version,
        sourceCommit: git(root, "rev-parse", "HEAD"),
        releaseInvocation: "test-release-build-1",
        fileName: tarballName,
        sizeBytes: (await readFile(coreTgz)).length,
        sha256: hash(await readFile(coreTgz))
      };
      const coreTransportMetadata = join(directory, "core-transport.json");
      await writeFile(coreTransportMetadata, JSON.stringify(metadata));
      return {
        coreTgz,
        coreTransportMetadata,
        expectedSourceCommit: metadata.sourceCommit,
        releaseInvocation: metadata.releaseInvocation
      };
    };
    return await run({ root, packCore, packagePrivateBeta, transferredCore });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshot(directory) {
  const result = {};
  for (const name of await readdir(directory)) {
    result[name] = hash(await readFile(join(directory, name)));
  }
  return result;
}

test("release build validates channels and requires explicit release date", () => {
  assert.deepEqual(parseReleaseBuildArgs(["--channel", "private-beta"]),
    { channel: "private-beta", releaseGrade: false });
  assert.throws(() => parseReleaseBuildArgs(["--channel", "beta"]), /no implemented handoff/);
  assert.throws(() => parseReleaseBuildArgs(["--channel", "stable"]), /no implemented handoff/);
  assert.throws(() => parseReleaseBuildArgs(["--channel", "nightly"]), /Unsupported channel/);
  assert.throws(() => parseReleaseBuildArgs(["--channel", "private-beta", "--release"]),
    /requires explicit --released-at/);
});

test("checksums are sorted, LF-terminated and reject self-reference and duplicates", () => {
  const text = checksumText([["z.zip", Buffer.from("z")], ["a.tgz", Buffer.from("a")]]);
  assert.equal(text, `${hash("a")}  a.tgz\n${hash("z")}  z.zip\n`);
  assert.throws(() => checksumText([["same", Buffer.from("a")], ["same", Buffer.from("b")]]),
    /Duplicate checksum filename/);
  assert.throws(() => checksumText([["SHA256SUMS.txt", Buffer.from("a")]]), /cannot hash itself/);
});

test("release set contains Core, handoff, manifest and independently valid sums", () => fixture(async ({ root, packCore, packagePrivateBeta }) => {
  const { directory, manifest } = await buildRelease({
    repositoryRoot: root, channel: "private-beta", packCore, packagePrivateBeta
  });
  assert.equal(directory, join(root, "artifacts", "releases", version, "private-beta"));
  assert.deepEqual((await readdir(directory)).sort(), [
    zipName, "SHA256SUMS.txt", tarballName, "release-manifest.json"
  ].sort());
  assert.deepEqual(manifest.artifacts.map(({ artifactId }) => artifactId),
    ["core-npm-tarball", "private-beta-handoff"]);
  assert.equal(manifest.source.gitCommit, git(root, "rev-parse", "HEAD"));
  assert.equal(manifest.source.dirty, false);
  assert.equal(manifest.source.gitTag, null);
  const sums = await readFile(join(directory, "SHA256SUMS.txt"), "utf8");
  const expected = checksumText(await Promise.all(
    [zipName, tarballName, "release-manifest.json"].map(async (name) =>
      [name, await readFile(join(directory, name))])
  ));
  assert.equal(sums, expected);
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(join(directory, artifact.fileName));
    assert.equal(artifact.sizeBytes, bytes.length);
    assert.equal(artifact.sha256, hash(bytes));
  }
  const embedded = unzipSync(new Uint8Array(await readFile(join(directory, zipName))))[
    `${zipName.slice(0, -4)}/package/${tarballName}`
  ];
  assert.deepEqual(Buffer.from(embedded), await readFile(join(directory, tarballName)));
  assert.ok(sums.includes("release-manifest.json"));
  assert.ok(!sums.includes("SHA256SUMS.txt"));
  const serialized = await readFile(join(directory, "release-manifest.json"), "utf8");
  assert.ok(!serialized.includes(root));
  assert.ok(!serialized.includes("artifacts\\private-beta"));
}));

test("identical builds replace stale final files and reproduce all four outputs", () => fixture(async ({ root, packCore, packagePrivateBeta }) => {
  const options = { repositoryRoot: root, channel: "private-beta", packCore, packagePrivateBeta };
  const first = await buildRelease(options);
  const hashes = await snapshot(first.directory);
  await writeFile(join(first.directory, "stale.txt"), "old run");
  const second = await buildRelease(options);
  assert.deepEqual(await snapshot(second.directory), hashes);
  assert.equal((await readdir(second.directory)).includes("stale.txt"), false);
}));

test("failed packaging leaves no completed set and preserves prior completed set", () => fixture(async ({ root, packCore, packagePrivateBeta }) => {
  const options = { repositoryRoot: root, channel: "private-beta", packCore, packagePrivateBeta };
  const first = await buildRelease(options);
  const hashes = await snapshot(first.directory);
  await assert.rejects(buildRelease({ ...options, packagePrivateBeta: async () => {
    throw new Error("synthetic packaging failure");
  } }), /synthetic packaging failure/);
  assert.deepEqual(await snapshot(first.directory), hashes);
  assert.deepEqual(await readdir(join(root, "artifacts", "releases", version)), ["private-beta"]);
}));

test("failed first build leaves no completed release directory", () => fixture(async ({ root, packCore }) => {
  await assert.rejects(buildRelease({
    repositoryRoot: root, channel: "private-beta", packCore,
    packagePrivateBeta: async () => { throw new Error("synthetic packaging failure"); }
  }), /synthetic packaging failure/);
  assert.deepEqual(await readdir(join(root, "artifacts", "releases", version)), []);
}));

test("corrupt handoff checksum cannot replace a valid release set", () => fixture(async ({ root, packCore, packagePrivateBeta }) => {
  const options = { repositoryRoot: root, channel: "private-beta", packCore, packagePrivateBeta };
  const completed = await buildRelease(options);
  const hashes = await snapshot(completed.directory);
  await assert.rejects(buildRelease({ ...options, packagePrivateBeta: async (_root, corePath) => {
    await packagePrivateBeta(undefined, corePath);
    const checksum = join(root, "artifacts", "private-beta", version, `${zipName}.sha256`);
    await writeFile(checksum, `${"0".repeat(64)}  ${zipName}\n`);
  } }), /ZIP checksum mismatch/);
  assert.deepEqual(await snapshot(completed.directory), hashes);
}));

test("handoff with a different embedded Core is rejected even with a valid ZIP checksum", () => fixture(async ({ root, packCore, packagePrivateBeta }) => {
  const options = { repositoryRoot: root, channel: "private-beta", packCore, packagePrivateBeta };
  const completed = await buildRelease(options);
  const hashes = await snapshot(completed.directory);
  await assert.rejects(buildRelease({ ...options, packagePrivateBeta: async () => {
    const output = join(root, "artifacts", "private-beta", version);
    const zip = Buffer.from(zipSync({
      [`${zipName.slice(0, -4)}/package/${tarballName}`]:
        new TextEncoder().encode("Different synthetic Core\n")
    }, { mtime: new Date(1980, 0, 1) }));
    await writeFile(join(output, zipName), zip);
    await writeFile(join(output, `${zipName}.sha256`), `${hash(zip)}  ${zipName}\n`);
  } }), /Core differs/);
  assert.deepEqual(await snapshot(completed.directory), hashes);
}));

test("dirty development provenance is explicit and release grade is refused", () => fixture(async ({ root, packCore, packagePrivateBeta, transferredCore }) => {
  const transport = await transferredCore();
  await writeFile(join(root, "pending.txt"), "uncommitted source");
  const options = { repositoryRoot: root, channel: "private-beta", packCore, packagePrivateBeta };
  const development = await buildRelease(options);
  assert.equal(development.manifest.source.dirty, true);
  assert.equal(development.manifest.source.gitTag, null);
  const completedHashes = await snapshot(development.directory);
  await assert.rejects(buildRelease({ ...options, releaseGrade: true,
    releasedAt: "2026-09-19T12:00:00.000Z", ...transport }), /clean tree and matching annotated version tag/);
  assert.deepEqual(await snapshot(development.directory), completedHashes);
}));

test("release-grade build requires annotated version tag at clean HEAD", () => fixture(async ({ root, packCore, packagePrivateBeta, transferredCore }) => {
  const transport = await transferredCore();
  const options = { repositoryRoot: root, channel: "private-beta", packCore, packagePrivateBeta,
    releaseGrade: true, releasedAt: "2026-09-19T12:00:00.000Z", ...transport };
  await assert.rejects(buildRelease(options), /clean tree and matching annotated version tag/);
  git(root, "-c", "user.name=PCW Test", "-c", "user.email=test@example.invalid",
    "tag", "-a", `v${version}`, "-m", "Synthetic release");
  const result = await buildRelease(options);
  assert.equal(result.manifest.source.gitTag, `v${version}`);
  assert.equal(result.manifest.source.dirty, false);
  assert.equal(result.manifest.releasedAt, options.releasedAt);
}));

test("release-grade set includes one verified Standard installer and hashes it", () =>
  fixture(async ({ root, packCore, packagePrivateBeta, transferredCore }) => {
    const transport = await transferredCore();
    const input = join(root, "artifacts", "standard-input");
    await mkdir(input, { recursive: true });
    const installerName = `PCW-Setup-${version}.exe`;
    const installerPath = join(input, installerName);
    const verificationPath = join(input, "installer-verification.json");
    const installerBytes = Buffer.from("Synthetic verified installer bytes\n");
    const installerSha256 = hash(installerBytes);
    const coreSha256 = hash("Synthetic Core bytes\n");
    await writeFile(installerPath, installerBytes);
    const verification = createStandardInstallerVerification({
      softwareVersion: version,
      sourceCommit: transport.expectedSourceCommit,
      releaseInvocation: transport.releaseInvocation,
      fileName: installerName,
      coreTgzSha256: coreSha256,
      preInnoInputSha256: hash("stable inputs"),
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
    await writeFile(verificationPath, JSON.stringify(verification));
    git(root, "-c", "user.name=PCW Test", "-c", "user.email=test@example.invalid",
      "tag", "-a", `v${version}`, "-m", "Synthetic release");
    const result = await buildRelease({
      repositoryRoot: root,
      channel: "private-beta",
      releaseGrade: true,
      releasedAt: "2026-09-19T12:00:00.000Z",
      standardWindowsInstaller: installerPath,
      standardWindowsVerification: verificationPath,
      ...transport,
      packCore,
      packagePrivateBeta
    });
    const artifact = result.manifest.artifacts.find(
      ({ artifactId }) => artifactId === "standard-windows-installer"
    );
    assert.deepEqual(artifact.target, { os: "windows", arch: "x64" });
    assert.deepEqual(artifact.runtime, { node: "22.23.3" });
    assert.equal(artifact.fileName, installerName);
    assert.equal(artifact.sha256, installerSha256);
    assert.ok((await readFile(join(result.directory, "SHA256SUMS.txt"), "utf8"))
      .includes(`${installerSha256}  ${installerName}`));
  }));
