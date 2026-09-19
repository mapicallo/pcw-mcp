import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";

import {
  createReleaseManifest,
  descriptorSchema,
  releaseManifestSchema,
  serializeReleaseManifest,
  validateOutputLocation
} from "./generate-release-manifest.mjs";
import { packCoreTarball } from "./pack-core.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedChannels = ["private-beta", "beta", "stable"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseReleaseBuildArgs(args) {
  const options = { releaseGrade: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--release" && !options.releaseGrade) {
      options.releaseGrade = true;
    } else if ((arg === "--channel" || arg === "--released-at") &&
               args[index + 1] && !args[index + 1].startsWith("--")) {
      const key = arg === "--channel" ? "channel" : "releasedAt";
      if (options[key] !== undefined) throw new Error(`Repeated option: ${arg}`);
      options[key] = args[++index];
    } else {
      throw new Error(`Invalid or incomplete option: ${arg}`);
    }
  }
  if (!allowedChannels.includes(options.channel)) {
    throw new Error(`Unsupported channel: ${options.channel ?? "(missing)"}`);
  }
  if (options.channel !== "private-beta") {
    throw new Error(`Channel ${options.channel} has no implemented handoff artifact`);
  }
  if (options.releaseGrade && !options.releasedAt) {
    throw new Error("Release-grade build requires explicit --released-at");
  }
  return options;
}

function runPrivateBetaPackage(repositoryRoot, corePath) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("release:build must be run through npm");
  const result = spawnSync(process.execPath, [
    npmCli, "run", "package:private-beta", "--", "--core-tarball", corePath
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("package:private-beta failed");
}

export function checksumText(files) {
  const names = files.map(([name]) => name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate checksum filename");
  if (names.includes("SHA256SUMS.txt")) throw new Error("Checksum file cannot hash itself");
  return `${files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join("\n")}\n`;
}

async function verifySet(directory, manifest) {
  const names = [
    ...manifest.artifacts.map((artifact) => artifact.fileName),
    "release-manifest.json", "SHA256SUMS.txt"
  ];
  if (new Set(names).size !== names.length) throw new Error("Duplicate release filename");
  const actualNames = (await readdir(directory)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...names].sort())) {
    throw new Error("Release set contains missing or unexpected files");
  }
  const checksumInputs = [];
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(join(directory, artifact.fileName));
    if (bytes.length !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`Artifact integrity mismatch: ${artifact.fileName}`);
    }
    checksumInputs.push([artifact.fileName, bytes]);
  }
  checksumInputs.push(["release-manifest.json", await readFile(join(directory, "release-manifest.json"))]);
  const expected = checksumText(checksumInputs);
  if (await readFile(join(directory, "SHA256SUMS.txt"), "utf8") !== expected) {
    throw new Error("Release checksums do not match final bytes");
  }
}

async function finalize(stage, finalDirectory, versionDirectory) {
  let previous;
  try {
    const metadata = await lstat(finalDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Existing release output is not a regular directory");
    }
    previous = join(versionDirectory, `.private-beta-previous-${randomUUID()}`);
    await rename(finalDirectory, previous);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(stage, finalDirectory);
  } catch (error) {
    if (previous) await rename(previous, finalDirectory);
    throw error;
  }
  if (previous) await rm(previous, { recursive: true });
}

export async function buildRelease({
  repositoryRoot = defaultRoot,
  channel,
  releaseGrade = false,
  releasedAt,
  packCore = packCoreTarball,
  packagePrivateBeta = runPrivateBetaPackage
}) {
  parseReleaseBuildArgs(["--channel", channel, ...(releaseGrade ? ["--release"] : []),
    ...(releasedAt === undefined ? [] : ["--released-at", releasedAt])]);
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const version = releaseManifestSchema.shape.softwareVersion.parse(packageJson.version);
  const versionDirectory = join(repositoryRoot, "artifacts", "releases", version);
  const finalDirectory = join(versionDirectory, channel);
  validateOutputLocation(repositoryRoot, finalDirectory, releaseGrade);
  await mkdir(versionDirectory, { recursive: true });
  const stage = await mkdtemp(join(versionDirectory, `.private-beta-stage-`));
  try {
    const zipName = `PCW-MCP-${version}-PRIVATE-BETA.zip`;
    const tarballName = `pcw-mcp-${version}.tgz`;
    const corePath = await packCore(repositoryRoot, stage, version);
    if (resolve(corePath) !== resolve(stage, tarballName)) {
      throw new Error("Core packager returned an unexpected path");
    }
    const coreBytes = await readFile(corePath);
    await packagePrivateBeta(repositoryRoot, corePath);
    const legacyZip = join(repositoryRoot, "artifacts", "private-beta", version, zipName);
    const zipBytes = await readFile(legacyZip);
    const externalChecksum = await readFile(`${legacyZip}.sha256`, "utf8");
    if (externalChecksum !== `${sha256(zipBytes)}  ${zipName}\n`) {
      throw new Error("Private-beta ZIP checksum mismatch");
    }
    const bundleName = zipName.slice(0, -4);
    const entries = unzipSync(new Uint8Array(zipBytes));
    const tarballBytes = entries[`${bundleName}/package/${tarballName}`];
    if (!tarballBytes) throw new Error("Verified handoff ZIP lacks its Core tarball");
    if (!coreBytes.equals(Buffer.from(tarballBytes))) {
      throw new Error("Handoff ZIP Core differs from the release-set Core tarball");
    }
    await cp(legacyZip, join(stage, zipName));

    const descriptor = descriptorSchema.parse({ artifacts: [
      { artifactId: "core-npm-tarball", type: "npm-tarball", file: tarballName,
        target: { os: "any", arch: "any" }, runtime: { node: packageJson.engines.node } },
      { artifactId: "private-beta-handoff", type: "private-handoff-zip", file: zipName,
        target: { os: "any", arch: "any" }, runtime: { node: packageJson.engines.node } }
    ] });
    const descriptorPath = join(stage, "artifact-descriptor.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
    const manifest = await createReleaseManifest({
      repositoryRoot, channel, descriptorPath, releaseGrade, releasedAt
    });
    await rm(descriptorPath);
    await writeFile(join(stage, "release-manifest.json"), serializeReleaseManifest(manifest));
    const checksumInputs = await Promise.all(
      [tarballName, zipName, "release-manifest.json"].map(async (name) =>
        [name, await readFile(join(stage, name))])
    );
    await writeFile(join(stage, "SHA256SUMS.txt"), checksumText(checksumInputs));
    await verifySet(stage, manifest);
    await finalize(stage, finalDirectory, versionDirectory);
    await verifySet(finalDirectory, manifest);
    return { directory: finalDirectory, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildRelease(parseReleaseBuildArgs(process.argv.slice(2)));
    process.stdout.write(`${result.directory}\n`);
  } catch (error) {
    process.stderr.write(`release:build: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  }
}
