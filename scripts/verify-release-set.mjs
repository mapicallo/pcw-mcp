import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";

import { releaseManifestSchema } from "./generate-release-manifest.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyReleaseSet(directory, { requireCleanSource = false } = {}) {
  const root = resolve(directory);
  const manifestBytes = await readFile(resolve(root, "release-manifest.json"));
  const manifest = releaseManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.channel !== "private-beta") {
    throw new Error("Only private-beta release sets are implemented");
  }
  if (requireCleanSource && manifest.source.dirty) {
    throw new Error("CI release set must come from a clean Git source");
  }

  const version = manifest.softwareVersion;
  const coreName = `pcw-mcp-${version}.tgz`;
  const bundleName = `PCW-MCP-${version}-PRIVATE-BETA`;
  const zipName = `${bundleName}.zip`;
  const names = [coreName, zipName, "release-manifest.json", "SHA256SUMS.txt"];
  const actual = (await readdir(root)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) {
    throw new Error("Release set has missing or unexpected files");
  }

  const expectedDescriptors = new Map([
    ["core-npm-tarball", { type: "npm-tarball", fileName: coreName }],
    ["private-beta-handoff", { type: "private-handoff-zip", fileName: zipName }]
  ]);
  if (manifest.artifacts.length !== expectedDescriptors.size) {
    throw new Error("Release manifest must describe exactly the Core and handoff ZIP");
  }
  const hashes = {};
  const bytes = new Map();
  for (const name of names) {
    const path = resolve(root, name);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Not a release file: ${name}`);
    const content = await readFile(path);
    bytes.set(name, content);
    hashes[name] = sha256(content);
  }
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    const expected = expectedDescriptors.get(artifact.artifactId);
    if (!expected || seen.has(artifact.artifactId) ||
        artifact.type !== expected.type || artifact.fileName !== expected.fileName) {
      throw new Error(`Unexpected or duplicate artifact descriptor: ${artifact.artifactId}`);
    }
    seen.add(artifact.artifactId);
    const content = bytes.get(artifact.fileName);
    if (artifact.sizeBytes !== content.length || artifact.sha256 !== hashes[artifact.fileName]) {
      throw new Error(`Release manifest integrity mismatch: ${artifact.fileName}`);
    }
  }

  const checksumNames = [coreName, zipName, "release-manifest.json"].sort();
  const expectedSums = `${checksumNames.map((name) => `${hashes[name]}  ${name}`).join("\n")}\n`;
  if (bytes.get("SHA256SUMS.txt").toString("utf8") !== expectedSums) {
    throw new Error("SHA256SUMS.txt does not match final release bytes");
  }
  const embedded = unzipSync(new Uint8Array(bytes.get(zipName)))[
    `${bundleName}/package/${coreName}`
  ];
  if (!embedded || !bytes.get(coreName).equals(Buffer.from(embedded))) {
    throw new Error("ZIP-embedded Core differs from the top-level Core tarball");
  }
  return hashes;
}

function parseArgs(args) {
  const options = { requireCleanSource: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--require-clean-source" && !options.requireCleanSource) {
      options.requireCleanSource = true;
    } else if (["--directory", "--snapshot", "--compare", "--metadata-directory"].includes(arg) &&
               args[index + 1] && !args[index + 1].startsWith("--")) {
      const key = arg === "--metadata-directory" ? "metadataDirectory" : arg.slice(2);
      if (options[key]) throw new Error(`Repeated option: ${arg}`);
      options[key] = args[++index];
    } else {
      throw new Error(`Invalid or incomplete option: ${arg}`);
    }
  }
  if (!options.directory || Boolean(options.snapshot) === Boolean(options.compare)) {
    throw new Error("Specify --directory and exactly one of --snapshot or --compare");
  }
  if (options.metadataDirectory && !options.compare) {
    throw new Error("--metadata-directory requires --compare");
  }
  for (const output of [options.snapshot ?? options.compare, options.metadataDirectory].filter(Boolean)) {
    const within = relative(resolve(options.directory), resolve(output));
    if (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)) {
      throw new Error("Verification output must be outside the completed release directory");
    }
  }
  return options;
}

async function writeVerificationMetadata(directory, releaseDirectory, hashes) {
  const manifest = JSON.parse(await readFile(resolve(releaseDirectory, "release-manifest.json"), "utf8"));
  const version = manifest.softwareVersion;
  const report = {
    reportSchemaVersion: 1,
    sourceCommit: manifest.source.gitCommit,
    softwareVersion: version,
    channel: manifest.channel,
    packagingNodeVersion: process.version,
    packagingNpmVersion: execSync("npm --version", { encoding: "utf8" }).trim(),
    coreTgzSha256: hashes[`pcw-mcp-${version}.tgz`],
    handoffZipSha256: hashes[`PCW-MCP-${version}-PRIVATE-BETA.zip`],
    releaseManifestSha256: hashes["release-manifest.json"],
    sha256sumsSha256: hashes["SHA256SUMS.txt"],
    deterministicBuildsMatch: true,
    embeddedCoreByteIdentical: true,
    verificationSucceeded: true
  };
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length !== 0) {
    throw new Error("Verification metadata directory must be empty");
  }
  await writeFile(resolve(directory, "release-manifest.json"),
    await readFile(resolve(releaseDirectory, "release-manifest.json")));
  await writeFile(resolve(directory, "SHA256SUMS.txt"),
    await readFile(resolve(releaseDirectory, "SHA256SUMS.txt")));
  await writeFile(resolve(directory, "verification-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hashes = await verifyReleaseSet(options.directory, options);
  const snapshot = `${JSON.stringify(hashes, null, 2)}\n`;
  if (options.snapshot) {
    await writeFile(options.snapshot, snapshot, "utf8");
  } else if (await readFile(options.compare, "utf8") !== snapshot) {
    throw new Error("Release set B differs from verified release set A");
  }
  if (options.metadataDirectory) {
    await writeVerificationMetadata(options.metadataDirectory, options.directory, hashes);
  }
  process.stdout.write(`${JSON.stringify(hashes)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`verify-release-set: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
