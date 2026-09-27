import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createCoreTransport,
  createStandardTransport,
  verifyCoreTransport,
  verifyStandardTransport
} from "./release-transport.mjs";

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid or incomplete option: ${name ?? "(missing)"}`);
    }
    const key = name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (options[key] !== undefined) throw new Error(`Repeated option: ${name}`);
    options[key] = value;
  }
  return { command, options };
}

function required(options, names) {
  for (const name of names) if (!options[name]) throw new Error(`${name} is required`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const common = {
    expectedSoftwareVersion: options.softwareVersion,
    expectedSourceCommit: options.sourceCommit,
    expectedReleaseInvocation: options.releaseInvocation
  };
  let result;
  if (command === "create-core") {
    required(options, ["repositoryRoot", "outputDirectory", "sourceCommit", "releaseInvocation"]);
    result = await createCoreTransport({
      repositoryRoot: resolve(options.repositoryRoot),
      outputDirectory: resolve(options.outputDirectory),
      sourceCommit: options.sourceCommit,
      releaseInvocation: options.releaseInvocation
    });
  } else if (command === "verify-core") {
    required(options, ["coreTgz", "metadata", "softwareVersion", "sourceCommit", "releaseInvocation"]);
    result = await verifyCoreTransport({
      coreTgz: resolve(options.coreTgz),
      metadataPath: resolve(options.metadata),
      expectedFileName: options.fileName,
      ...common
    });
  } else if (command === "create-standard") {
    required(options, ["coreTgz", "coreMetadata", "buildA", "buildB", "reproducibility",
      "lifecycle", "outputDirectory", "softwareVersion", "sourceCommit", "releaseInvocation"]);
    result = await createStandardTransport({
      coreTgz: resolve(options.coreTgz),
      coreMetadataPath: resolve(options.coreMetadata),
      buildAPath: resolve(options.buildA),
      buildBPath: resolve(options.buildB),
      reproducibilityPath: resolve(options.reproducibility),
      lifecyclePath: resolve(options.lifecycle),
      outputDirectory: resolve(options.outputDirectory),
      contextPreserved: options.contextPreserved === "true",
      ...common
    });
  } else if (command === "verify-standard") {
    required(options, ["directory", "coreTgz", "coreMetadata", "softwareVersion",
      "sourceCommit", "releaseInvocation"]);
    result = await verifyStandardTransport({
      directory: resolve(options.directory),
      coreTgz: resolve(options.coreTgz),
      coreMetadataPath: resolve(options.coreMetadata),
      releaseGrade: options.releaseGrade === "true",
      ...common
    });
  } else {
    throw new Error(`Unknown release transport command: ${command ?? "(missing)"}`);
  }
  const summary = result.metadata ?? JSON.parse(await readFile(result.metadataPath, "utf8"));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  process.stderr.write(`release:transport: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
