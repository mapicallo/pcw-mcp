import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { packCoreTarball } from "./pack-core.mjs";
import {
  createStandardInstallerVerification,
  standardInstallerVerificationSchema,
  validateStandardInstallerArtifact
} from "./standard-installer-release.mjs";

export const CORE_TRANSPORT_METADATA_FILE = "core-transport.json";
export const STANDARD_TRANSPORT_METADATA_FILE = "standard-transport.json";
export const STANDARD_VERIFICATION_FILE = "standard-verification.json";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const invocationSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u);
const fileNameSchema = z.string().min(1).refine(
  (value) => basename(value) === value && value !== "." && value !== "..",
  "Expected a filename without path components"
);

export const coreTransportMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  transportType: z.literal("pcw-core"),
  softwareVersion: z.string().min(1),
  sourceCommit: commitSchema,
  releaseInvocation: invocationSchema,
  fileName: fileNameSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256Schema
}).strict();

export const standardTransportMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  transportType: z.literal("pcw-standard-verified"),
  softwareVersion: z.string().min(1),
  sourceCommit: commitSchema,
  releaseInvocation: invocationSchema,
  fileName: fileNameSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
  coreFileName: fileNameSchema,
  coreSha256: sha256Schema,
  verificationFileName: z.literal(STANDARD_VERIFICATION_FILE),
  verificationSha256: sha256Schema
}).strict();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(path, schema, label) {
  try {
    return schema.parse(JSON.parse((await readFile(resolve(path), "utf8")).replace(/^\uFEFF/u, "")));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function requireExpected(actual, expected, label) {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
  }
}

async function requireEmptyDirectory(path, label) {
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length !== 0) throw new Error(`${label} must be empty`);
}

async function requireExactFiles(path, expected, label) {
  const actual = (await readdir(path)).sort();
  const names = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(names)) {
    throw new Error(`${label} contains missing or unexpected files`);
  }
}

export async function createCoreTransport({
  repositoryRoot,
  outputDirectory,
  sourceCommit,
  releaseInvocation,
  packCore = packCoreTarball
}) {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const softwareVersion = z.string().min(1).parse(packageJson.version);
  const expectedName = `pcw-mcp-${softwareVersion}.tgz`;
  const metadataBase = coreTransportMetadataSchema.pick({
    sourceCommit: true,
    releaseInvocation: true
  }).parse({ sourceCommit, releaseInvocation });
  await requireEmptyDirectory(outputDirectory, "Core transport output");
  const coreTgz = await packCore(repositoryRoot, outputDirectory, softwareVersion, { alreadyBuilt: true });
  if (basename(coreTgz) !== expectedName) {
    throw new Error(`Canonical Core producer returned unexpected filename: ${basename(coreTgz)}`);
  }
  const bytes = await readFile(coreTgz);
  const metadata = coreTransportMetadataSchema.parse({
    schemaVersion: 1,
    transportType: "pcw-core",
    softwareVersion,
    ...metadataBase,
    fileName: expectedName,
    sizeBytes: bytes.length,
    sha256: sha256(bytes)
  });
  const metadataPath = join(outputDirectory, CORE_TRANSPORT_METADATA_FILE);
  await writeFile(metadataPath, serialize(metadata), "utf8");
  return { coreTgz, metadataPath, metadata };
}

export async function verifyCoreTransport({
  coreTgz,
  metadataPath,
  expectedSoftwareVersion,
  expectedSourceCommit,
  expectedReleaseInvocation,
  expectedFileName
}) {
  const metadata = await readJson(metadataPath, coreTransportMetadataSchema, "Core transport metadata");
  requireExpected(metadata.softwareVersion, expectedSoftwareVersion, "Core softwareVersion");
  requireExpected(metadata.sourceCommit, expectedSourceCommit, "Core sourceCommit");
  requireExpected(metadata.releaseInvocation, expectedReleaseInvocation, "Core releaseInvocation");
  requireExpected(metadata.fileName, expectedFileName, "Core filename");
  if (basename(coreTgz) !== metadata.fileName) {
    throw new Error("Core filename does not match transport metadata");
  }
  if (dirname(resolve(coreTgz)) !== dirname(resolve(metadataPath))) {
    throw new Error("Core TGZ and metadata must share one transport directory");
  }
  await requireExactFiles(dirname(resolve(coreTgz)), [metadata.fileName, CORE_TRANSPORT_METADATA_FILE],
    "Core transport");
  const bytes = await readFile(resolve(coreTgz));
  if (bytes.length !== metadata.sizeBytes || sha256(bytes) !== metadata.sha256) {
    throw new Error("Canonical Core bytes do not match transport metadata");
  }
  return { path: resolve(coreTgz), bytes, metadata };
}

const buildReportSchema = z.object({
  ok: z.literal(true),
  installer: z.string().min(1),
  prototype: z.boolean(),
  inputFingerprint: sha256Schema,
  installerSha256: sha256Schema,
  coreTgzSha256: sha256Schema,
  softwareVersion: z.string().min(1)
}).passthrough();

const reproducibilitySchema = z.object({
  schemaVersion: z.literal(1),
  deterministicBuildsMatch: z.literal(true),
  preInnoInputSha256: sha256Schema,
  installerSha256: sha256Schema,
  coreTgzSha256: sha256Schema,
  softwareVersion: z.string().min(1),
  sizeBytes: z.number().int().nonnegative()
}).strict();

const lifecycleSchema = z.object({
  installerSha256: sha256Schema,
  passed: z.literal(true),
  mcpToolCount: z.literal(16),
  workstreamCreated: z.literal(true),
  realClientConfigUsed: z.literal(false)
}).strict();

export async function createStandardTransport({
  coreTgz,
  coreMetadataPath,
  buildAPath,
  buildBPath,
  reproducibilityPath,
  lifecyclePath,
  outputDirectory,
  expectedSoftwareVersion,
  expectedSourceCommit,
  expectedReleaseInvocation,
  contextPreserved
}) {
  if (contextPreserved !== true) throw new Error("Standard transport requires preserved-context evidence");
  const core = await verifyCoreTransport({
    coreTgz,
    metadataPath: coreMetadataPath,
    expectedSoftwareVersion,
    expectedSourceCommit,
    expectedReleaseInvocation,
    expectedFileName: `pcw-mcp-${expectedSoftwareVersion}.tgz`
  });
  const [buildA, buildB, reproducibility, lifecycle] = await Promise.all([
    readJson(buildAPath, buildReportSchema, "installer build A report"),
    readJson(buildBPath, buildReportSchema, "installer build B report"),
    readJson(reproducibilityPath, reproducibilitySchema, "installer reproducibility report"),
    readJson(lifecyclePath, lifecycleSchema, "installer lifecycle report")
  ]);
  const installerPath = resolve(buildA.installer);
  const installerBytes = await readFile(installerPath);
  const installerSha256 = sha256(installerBytes);
  const buildBBytes = await readFile(resolve(buildB.installer));
  const values = [
    buildA.installerSha256,
    buildB.installerSha256,
    reproducibility.installerSha256,
    lifecycle.installerSha256
  ];
  if (values.some((value) => value !== installerSha256)) {
    throw new Error("Returned installer bytes differ from build, reproducibility, or lifecycle evidence");
  }
  if (sha256(buildBBytes) !== buildB.installerSha256 || !installerBytes.equals(buildBBytes) ||
      reproducibility.sizeBytes !== installerBytes.length) {
    throw new Error("Installer build B or reproducibility size differs from exact installer A bytes");
  }
  if (resolve(buildB.installer) === installerPath) {
    throw new Error("Installer builds A and B must be independent files");
  }
  if (buildA.prototype !== buildB.prototype) throw new Error("Installer build modes differ");
  for (const report of [buildA, buildB, reproducibility]) {
    if (report.softwareVersion !== core.metadata.softwareVersion ||
        report.coreTgzSha256 !== core.metadata.sha256) {
      throw new Error("Installer evidence does not match the transported canonical Core");
    }
  }
  if (reproducibility.preInnoInputSha256 !== buildA.inputFingerprint ||
      buildA.inputFingerprint !== buildB.inputFingerprint) {
    throw new Error("Installer pre-Inno fingerprint evidence does not match");
  }
  const fileName = basename(installerPath);
  const verification = createStandardInstallerVerification({
    softwareVersion: core.metadata.softwareVersion,
    sourceCommit: core.metadata.sourceCommit,
    releaseInvocation: core.metadata.releaseInvocation,
    fileName,
    prototype: buildA.prototype,
    coreTgzSha256: core.metadata.sha256,
    preInnoInputSha256: reproducibility.preInnoInputSha256,
    buildASha256: buildA.installerSha256,
    buildBSha256: buildB.installerSha256,
    lifecycle: { ...lifecycle, contextPreserved: true }
  });
  await requireEmptyDirectory(outputDirectory, "Standard transport output");
  const outputInstaller = join(outputDirectory, fileName);
  await copyFile(installerPath, outputInstaller);
  if (sha256(await readFile(outputInstaller)) !== installerSha256) {
    throw new Error("Installer changed while creating Standard transport");
  }
  const verificationBytes = Buffer.from(serialize(verification));
  const verificationPath = join(outputDirectory, STANDARD_VERIFICATION_FILE);
  await writeFile(verificationPath, verificationBytes);
  const metadata = standardTransportMetadataSchema.parse({
    schemaVersion: 1,
    transportType: "pcw-standard-verified",
    softwareVersion: core.metadata.softwareVersion,
    sourceCommit: core.metadata.sourceCommit,
    releaseInvocation: core.metadata.releaseInvocation,
    fileName,
    sizeBytes: installerBytes.length,
    sha256: installerSha256,
    coreFileName: core.metadata.fileName,
    coreSha256: core.metadata.sha256,
    verificationFileName: STANDARD_VERIFICATION_FILE,
    verificationSha256: sha256(verificationBytes)
  });
  const metadataPath = join(outputDirectory, STANDARD_TRANSPORT_METADATA_FILE);
  await writeFile(metadataPath, serialize(metadata), "utf8");
  return { installerPath: outputInstaller, verificationPath, metadataPath, metadata, verification };
}

export async function verifyStandardTransport({
  directory,
  coreTgz,
  coreMetadataPath,
  expectedSoftwareVersion,
  expectedSourceCommit,
  expectedReleaseInvocation,
  releaseGrade = false
}) {
  const core = await verifyCoreTransport({
    coreTgz,
    metadataPath: coreMetadataPath,
    expectedSoftwareVersion,
    expectedSourceCommit,
    expectedReleaseInvocation,
    expectedFileName: `pcw-mcp-${expectedSoftwareVersion}.tgz`
  });
  const metadataPath = join(directory, STANDARD_TRANSPORT_METADATA_FILE);
  const metadata = await readJson(metadataPath, standardTransportMetadataSchema, "Standard transport metadata");
  requireExpected(metadata.softwareVersion, core.metadata.softwareVersion, "Standard softwareVersion");
  requireExpected(metadata.sourceCommit, core.metadata.sourceCommit, "Standard sourceCommit");
  requireExpected(metadata.releaseInvocation, core.metadata.releaseInvocation, "Standard releaseInvocation");
  requireExpected(metadata.coreFileName, core.metadata.fileName, "Standard Core filename");
  requireExpected(metadata.coreSha256, core.metadata.sha256, "Standard Core SHA-256");
  await requireExactFiles(directory,
    [metadata.fileName, metadata.verificationFileName, STANDARD_TRANSPORT_METADATA_FILE],
    "Standard transport");
  const installerPath = join(directory, metadata.fileName);
  const verificationPath = join(directory, metadata.verificationFileName);
  const [installerBytes, verificationBytes] = await Promise.all([
    readFile(installerPath),
    readFile(verificationPath)
  ]);
  if (installerBytes.length !== metadata.sizeBytes || sha256(installerBytes) !== metadata.sha256) {
    throw new Error("Returned installer bytes do not match Standard transport metadata");
  }
  if (sha256(verificationBytes) !== metadata.verificationSha256) {
    throw new Error("Standard verification evidence does not match transport metadata");
  }
  const verification = standardInstallerVerificationSchema.parse(
    JSON.parse(verificationBytes.toString("utf8").replace(/^\uFEFF/u, ""))
  );
  if (verification.sourceCommit !== metadata.sourceCommit ||
      verification.releaseInvocation !== metadata.releaseInvocation ||
      verification.coreTgzSha256 !== metadata.coreSha256 ||
      verification.softwareVersion !== metadata.softwareVersion ||
      verification.fileName !== metadata.fileName) {
    throw new Error("Standard installer evidence provenance does not match its transport");
  }
  if (verification.buildAInstallerSha256 !== metadata.sha256 ||
      verification.buildBInstallerSha256 !== metadata.sha256 ||
      verification.lifecycle.installerSha256 !== metadata.sha256) {
    throw new Error("Standard installer evidence does not identify the returned installer bytes");
  }
  if (releaseGrade) {
    await validateStandardInstallerArtifact({
      installerPath,
      verification,
      softwareVersion: metadata.softwareVersion,
      sourceCommit: metadata.sourceCommit,
      releaseInvocation: metadata.releaseInvocation,
      coreTgzSha256: metadata.coreSha256,
      releaseGrade: true
    });
  }
  return { installerPath, verificationPath, metadataPath, metadata, verification };
}
