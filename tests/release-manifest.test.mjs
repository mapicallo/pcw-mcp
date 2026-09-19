import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReleaseManifest,
  releaseManifestSchema,
  serializeReleaseManifest,
  validateOutputLocation
} from "../scripts/generate-release-manifest.mjs";

const version = "7.8.9-dev.2";
const releasedAt = "2026-09-19T12:00:00.000Z";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function fixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), "pcw-release-manifest-"));
  const repositoryRoot = join(temporary, "repo");
  const artifactRoot = join(temporary, "artifacts");
  const descriptorPath = join(artifactRoot, "descriptor.json");
  try {
    await mkdir(repositoryRoot);
    await mkdir(artifactRoot);
    await writeFile(join(repositoryRoot, "package.json"),
      JSON.stringify({ name: "pcw-mcp", version }), "utf8");
    git(repositoryRoot, "init", "-q");
    git(repositoryRoot, "add", "package.json");
    git(repositoryRoot, "-c", "user.name=PCW Test",
      "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
      "commit", "-qm", "synthetic baseline");
    const content = Buffer.from("Synthetic PCW Core bytes\n");
    await writeFile(join(artifactRoot, "core.tgz"), content);
    const descriptor = {
      artifacts: [{
        artifactId: "core",
        type: "npm-tarball",
        file: "core.tgz",
        target: { os: "any", arch: "any" },
        runtime: { node: ">=22.9.0" }
      }]
    };
    await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
    return await run({
      repositoryRoot, artifactRoot, descriptorPath, descriptor, content,
      options: { repositoryRoot, descriptorPath, channel: "private-beta" }
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("software version and product ID come from package.json", () => fixture(async ({ options }) => {
  const manifest = await createReleaseManifest(options);
  assert.equal(manifest.softwareVersion, version);
  assert.equal(manifest.productId, "pcw-mcp");
  assert.equal(manifest.manifestSchemaVersion, 1);
}));

for (const channel of ["private-beta", "beta", "stable"]) {
  test(`channel ${channel} is accepted`, () => fixture(async ({ options }) => {
    assert.equal((await createReleaseManifest({ ...options, channel })).channel, channel);
  }));
}

test("unsupported channel is rejected", () => fixture(async ({ options }) => {
  await assert.rejects(createReleaseManifest({ ...options, channel: "nightly" }), /Invalid channel/);
}));

test("size and SHA-256 come from artifact bytes", () => fixture(async ({ options, content }) => {
  const [artifact] = (await createReleaseManifest(options)).artifacts;
  assert.equal(artifact.sizeBytes, content.length);
  assert.equal(artifact.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(artifact.fileName, "core.tgz");
}));

test("missing and non-file artifacts are rejected", () => fixture(async ({
  options, descriptorPath, descriptor
}) => {
  descriptor.artifacts[0].file = "missing.tgz";
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  await assert.rejects(createReleaseManifest(options), /Artifact not found/);
  descriptor.artifacts[0].file = ".";
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  await assert.rejects(createReleaseManifest(options), /Artifact is not a file/);
}));

test("manifest serialization is deterministic and orders artifact IDs", () => fixture(async ({
  options, artifactRoot, descriptorPath, descriptor
}) => {
  await writeFile(join(artifactRoot, "second.zip"), "Synthetic ZIP bytes");
  descriptor.artifacts.unshift({
    artifactId: "z-handoff", type: "private-handoff-zip", file: "second.zip"
  });
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const first = serializeReleaseManifest(await createReleaseManifest(options));
  const second = serializeReleaseManifest(await createReleaseManifest(options));
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first).artifacts.map((artifact) => artifact.artifactId),
    ["core", "z-handoff"]);
  assert.equal(first.endsWith("\n"), true);
}));

test("Git provenance uses the actual clean HEAD without inventing a tag", () => fixture(async ({
  options, repositoryRoot
}) => {
  const source = (await createReleaseManifest(options)).source;
  assert.equal(source.gitCommit, git(repositoryRoot, "rev-parse", "HEAD"));
  assert.equal(source.gitTag, null);
  assert.equal(source.dirty, false);
}));

test("matching annotated version tag is reported for clean HEAD", () => fixture(async ({
  options, repositoryRoot
}) => {
  git(repositoryRoot, "-c", "user.name=PCW Test",
    "-c", "user.email=test@example.invalid", "-c", "tag.gpgsign=false",
    "tag", "-a", `v${version}`, "-m", "Synthetic release");
  const manifest = await createReleaseManifest({
    ...options, releaseGrade: true, releasedAt
  });
  assert.equal(manifest.source.gitTag, `v${version}`);
  assert.equal(manifest.source.dirty, false);
  assert.equal(manifest.releasedAt, releasedAt);
}));

test("dirty worktree is visible and suppresses release tag", () => fixture(async ({
  options, repositoryRoot
}) => {
  git(repositoryRoot, "-c", "user.name=PCW Test",
    "-c", "user.email=test@example.invalid", "tag", "-a", `v${version}`,
    "-m", "Synthetic release");
  await writeFile(join(repositoryRoot, "pending.txt"), "synthetic change");
  const source = (await createReleaseManifest(options)).source;
  assert.equal(source.dirty, true);
  assert.equal(source.gitTag, null);
  await assert.rejects(
    createReleaseManifest({ ...options, releaseGrade: true, releasedAt }),
    /clean tree and matching annotated version tag/
  );
}));

test("release grade rejects missing or lightweight version tag", () => fixture(async ({
  options, repositoryRoot
}) => {
  await assert.rejects(createReleaseManifest({ ...options, releaseGrade: true, releasedAt }),
    /matching annotated version tag/);
  git(repositoryRoot, "tag", `v${version}`);
  await assert.rejects(createReleaseManifest({ ...options, releaseGrade: true, releasedAt }),
    /matching annotated version tag/);
}));

test("release date is explicit, canonical, and required for release grade", () => fixture(async ({
  options, repositoryRoot
}) => {
  const development = await createReleaseManifest(options);
  assert.equal("releasedAt" in development, false);
  await assert.rejects(createReleaseManifest({ ...options, releasedAt: "today" }),
    /releasedAt must be a canonical UTC/);
  git(repositoryRoot, "-c", "user.name=PCW Test",
    "-c", "user.email=test@example.invalid", "tag", "-a", `v${version}`,
    "-m", "Synthetic release");
  await assert.rejects(createReleaseManifest({ ...options, releaseGrade: true }),
    /requires explicit --released-at/);
}));

test("malformed descriptor JSON and unknown metadata are rejected", () => fixture(async ({
  options, descriptorPath, descriptor
}) => {
  await writeFile(descriptorPath, "{invalid");
  await assert.rejects(createReleaseManifest(options), /Invalid JSON/);
  descriptor.artifacts[0].downloadUrl = "https://example.invalid/file";
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  await assert.rejects(createReleaseManifest(options), /Invalid artifact descriptor/);
}));

test("invalid artifact metadata and duplicate IDs are rejected", () => fixture(async ({
  options, descriptorPath, descriptor
}) => {
  descriptor.artifacts[0].target.os = "mars";
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  await assert.rejects(createReleaseManifest(options), /Invalid artifact descriptor/);
  descriptor.artifacts[0].target.os = "any";
  descriptor.artifacts.push({ ...descriptor.artifacts[0] });
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  await assert.rejects(createReleaseManifest(options), /Duplicate artifact ID/);
}));

test("generated manifest validates without provider-specific URL fields", () => fixture(async ({
  options
}) => {
  const manifest = await createReleaseManifest(options);
  assert.equal(releaseManifestSchema.safeParse(manifest).success, true);
  assert.equal("downloadUrl" in manifest.artifacts[0], false);
  assert.equal(releaseManifestSchema.safeParse({
    ...manifest, artifacts: [{ ...manifest.artifacts[0], downloadUrl: "https://example.invalid" }]
  }).success, false);
}));

test("package name and version must be present", () => fixture(async ({
  options, repositoryRoot
}) => {
  await writeFile(join(repositoryRoot, "package.json"), JSON.stringify({ name: "pcw-mcp" }));
  await assert.rejects(createReleaseManifest(options), /Invalid package version/);
  await writeFile(join(repositoryRoot, "package.json"),
    JSON.stringify({ name: "pcw-mcp", version: "not-semver" }));
  await assert.rejects(createReleaseManifest(options), /Invalid package version/);
}));

test('release-grade output must be outside the repo or Git-ignored', () => fixture(async ({
  repositoryRoot, artifactRoot
}) => {
  assert.throws(
    () => validateOutputLocation(repositoryRoot, join(repositoryRoot, 'manifest.json'), true),
    /must be Git-ignored/
  );
  await writeFile(join(repositoryRoot, '.gitignore'), 'artifacts/\n');
  assert.doesNotThrow(() => validateOutputLocation(
    repositoryRoot, join(repositoryRoot, 'artifacts', 'manifest.json'), true
  ));
  assert.doesNotThrow(() => validateOutputLocation(
    repositoryRoot, join(artifactRoot, 'manifest.json'), true
  ));
}));
