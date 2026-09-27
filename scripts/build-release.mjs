import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
import { verifyCoreTransport } from "./release-transport.mjs";
import { validateStandardInstallerArtifact } from "./standard-installer-release.mjs";

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
    } else if ((arg === "--channel" || arg === "--released-at" ||
                arg === "--standard-windows-installer" ||
                arg === "--standard-windows-verification" ||
                arg === "--core-tgz" || arg === "--core-transport-metadata" ||
                arg === "--expected-source-commit" || arg === "--release-invocation") &&
               args[index + 1] && !args[index + 1].startsWith("--")) {
      const key = new Map([
        ["--channel", "channel"],
        ["--released-at", "releasedAt"],
        ["--standard-windows-installer", "standardWindowsInstaller"],
        ["--standard-windows-verification", "standardWindowsVerification"],
        ["--core-tgz", "coreTgz"],
        ["--core-transport-metadata", "coreTransportMetadata"],
        ["--expected-source-commit", "expectedSourceCommit"],
        ["--release-invocation", "releaseInvocation"]
      ]).get(arg);
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
  if (Boolean(options.standardWindowsInstaller) !== Boolean(options.standardWindowsVerification)) {
    throw new Error("Standard Windows installer and verification evidence must be supplied together");
  }
  if (options.standardWindowsInstaller && !options.releaseGrade) {
    throw new Error("Official Standard Windows artifact requires release-grade build mode");
  }
  const transferredCore = [options.coreTgz, options.coreTransportMetadata,
    options.expectedSourceCommit, options.releaseInvocation];
  if (transferredCore.some(Boolean) && !transferredCore.every(Boolean)) {
    throw new Error("Transferred Core requires TGZ, metadata, source commit, and release invocation");
  }
  if (options.releaseGrade && !transferredCore.every(Boolean)) {
    throw new Error("Release-grade build requires the transferred canonical Core; source repack is forbidden");
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
  standardWindowsInstaller,
  standardWindowsVerification,
  coreTgz,
  coreTransportMetadata,
  expectedSourceCommit,
  releaseInvocation,
  packCore = packCoreTarball,
  packagePrivateBeta = runPrivateBetaPackage
}) {
  parseReleaseBuildArgs(["--channel", channel, ...(releaseGrade ? ["--release"] : []),
    ...(releasedAt === undefined ? [] : ["--released-at", releasedAt]),
    ...(standardWindowsInstaller === undefined ? [] :
      ["--standard-windows-installer", standardWindowsInstaller,
       "--standard-windows-verification", standardWindowsVerification]),
    ...(coreTgz === undefined ? [] : [
      "--core-tgz", coreTgz,
      "--core-transport-metadata", coreTransportMetadata,
      "--expected-source-commit", expectedSourceCommit,
      "--release-invocation", releaseInvocation
    ])]);
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
    let corePath;
    let coreBytes;
    if (coreTgz) {
      const transported = await verifyCoreTransport({
        coreTgz: resolve(coreTgz),
        metadataPath: resolve(coreTransportMetadata),
        expectedSoftwareVersion: version,
        expectedSourceCommit,
        expectedReleaseInvocation: releaseInvocation,
        expectedFileName: tarballName
      });
      corePath = join(stage, tarballName);
      await copyFile(transported.path, corePath);
      coreBytes = await readFile(corePath);
      if (!coreBytes.equals(transported.bytes)) {
        throw new Error("Canonical Core changed while entering release finalization");
      }
    } else {
      corePath = await packCore(repositoryRoot, stage, version);
      if (resolve(corePath) !== resolve(stage, tarballName)) {
        throw new Error("Core packager returned an unexpected path");
      }
      coreBytes = await readFile(corePath);
    }
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

    const artifacts = [
      { artifactId: "core-npm-tarball", type: "npm-tarball", file: tarballName,
        target: { os: "any", arch: "any" }, runtime: { node: packageJson.engines.node } },
      { artifactId: "private-beta-handoff", type: "private-handoff-zip", file: zipName,
        target: { os: "any", arch: "any" }, runtime: { node: packageJson.engines.node } }
    ];
    if (standardWindowsInstaller) {
      const verification = JSON.parse(await readFile(resolve(standardWindowsVerification), "utf8"));
      const standardDescriptor = await validateStandardInstallerArtifact({
        installerPath: resolve(standardWindowsInstaller),
        verification,
        softwareVersion: version,
        sourceCommit: expectedSourceCommit,
        releaseInvocation,
        coreTgzSha256: sha256(coreBytes),
        releaseGrade
      });
      await cp(resolve(standardWindowsInstaller), join(stage, standardDescriptor.file));
      artifacts.push(standardDescriptor);
    }
    const descriptor = descriptorSchema.parse({ artifacts });
    const descriptorPath = join(stage, "artifact-descriptor.json");
    await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
    const manifest = await createReleaseManifest({
      repositoryRoot, channel, descriptorPath, releaseGrade, releasedAt
    });
    if (coreTgz && manifest.source.gitCommit !== expectedSourceCommit) {
      throw new Error("Transported Core source commit does not match release finalization HEAD");
    }
    await rm(descriptorPath);
    await writeFile(join(stage, "release-manifest.json"), serializeReleaseManifest(manifest));
    const checksumInputs = await Promise.all(
      [...manifest.artifacts.map(({ fileName }) => fileName), "release-manifest.json"]
        .map(async (name) =>
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
