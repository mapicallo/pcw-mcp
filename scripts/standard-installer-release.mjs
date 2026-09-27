import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { z } from "zod";

import {
  officialInstallerName,
  PINNED_INNO_SETUP_VERSION,
  PINNED_STANDARD_NODE_VERSION,
  PINNED_STANDARD_NODE_ZIP_SHA256,
  PINNED_STANDARD_NPM_VERSION
} from "./build-standard-windows-installer.mjs";

export const STANDARD_WINDOWS_ARTIFACT_ID = "standard-windows-installer";
export const STANDARD_WINDOWS_ARTIFACT_TYPE = "windows-installer";
export const PINNED_INNO_INSTALLER_SHA256 =
  "f3c42116542c4cc57263c5ba6c4feabfc49fe771f2f98a79d2f7628b8762723b";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const standardInstallerVerificationSchema = z.object({
  schemaVersion: z.literal(2),
  artifactId: z.literal(STANDARD_WINDOWS_ARTIFACT_ID),
  type: z.literal(STANDARD_WINDOWS_ARTIFACT_TYPE),
  softwareVersion: z.string().min(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  releaseInvocation: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
  fileName: z.string().min(1),
  prototype: z.boolean(),
  target: z.object({ os: z.literal("windows"), arch: z.literal("x64") }).strict(),
  runtime: z.object({ node: z.literal(PINNED_STANDARD_NODE_VERSION) }).strict(),
  coreTgzSha256: sha256Schema,
  nodeInputSha256: z.literal(PINNED_STANDARD_NODE_ZIP_SHA256),
  npmVersion: z.literal(PINNED_STANDARD_NPM_VERSION),
  innoVersion: z.literal(PINNED_INNO_SETUP_VERSION),
  innoInstallerSha256: z.literal(PINNED_INNO_INSTALLER_SHA256),
  signed: z.literal(false),
  preInnoInputSha256: sha256Schema,
  buildAInstallerSha256: sha256Schema,
  buildBInstallerSha256: sha256Schema,
  deterministicBuildsMatch: z.literal(true),
  lifecycle: z.object({
    installerSha256: sha256Schema,
    passed: z.literal(true),
    mcpToolCount: z.literal(16),
    workstreamCreated: z.literal(true),
    contextPreserved: z.literal(true),
    realClientConfigUsed: z.literal(false)
  }).strict()
}).strict();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function validateStandardInstallerArtifact({
  installerPath,
  verification,
  softwareVersion,
  sourceCommit,
  releaseInvocation,
  coreTgzSha256,
  releaseGrade = false
}) {
  const evidence = standardInstallerVerificationSchema.parse(verification);
  if (releaseGrade && /(?:^|[.-])dev(?:[.-]|$)/iu.test(softwareVersion)) {
    throw new Error("Release-grade Standard installer refuses development software versions");
  }
  const expectedName = officialInstallerName(softwareVersion);
  if (evidence.softwareVersion !== softwareVersion ||
      evidence.sourceCommit !== sourceCommit ||
      evidence.releaseInvocation !== releaseInvocation ||
      evidence.prototype ||
      evidence.fileName !== expectedName ||
      basename(installerPath) !== expectedName) {
    throw new Error("Standard installer identity does not match the release software version");
  }
  if (evidence.coreTgzSha256 !== coreTgzSha256) {
    throw new Error("Standard installer Core SHA does not match the canonical release Core");
  }
  const installerSha256 = sha256(await readFile(installerPath));
  const hashes = [
    evidence.buildAInstallerSha256,
    evidence.buildBInstallerSha256,
    evidence.lifecycle.installerSha256
  ];
  if (hashes.some((value) => value !== installerSha256)) {
    throw new Error("Standard installer bytes differ from reproducibility or lifecycle evidence");
  }
  return {
    artifactId: STANDARD_WINDOWS_ARTIFACT_ID,
    type: STANDARD_WINDOWS_ARTIFACT_TYPE,
    file: expectedName,
    target: { os: "windows", arch: "x64" },
    runtime: { node: PINNED_STANDARD_NODE_VERSION }
  };
}

export function createStandardInstallerVerification({
  softwareVersion,
  sourceCommit,
  releaseInvocation,
  fileName,
  prototype = false,
  coreTgzSha256,
  preInnoInputSha256,
  buildASha256,
  buildBSha256,
  lifecycle
}) {
  if (buildASha256 !== buildBSha256) {
    throw new Error("Unsigned Standard installer builds are not byte-identical");
  }
  return standardInstallerVerificationSchema.parse({
    schemaVersion: 2,
    artifactId: STANDARD_WINDOWS_ARTIFACT_ID,
    type: STANDARD_WINDOWS_ARTIFACT_TYPE,
    softwareVersion,
    sourceCommit,
    releaseInvocation,
    fileName,
    prototype,
    target: { os: "windows", arch: "x64" },
    runtime: { node: PINNED_STANDARD_NODE_VERSION },
    coreTgzSha256,
    nodeInputSha256: PINNED_STANDARD_NODE_ZIP_SHA256,
    npmVersion: PINNED_STANDARD_NPM_VERSION,
    innoVersion: PINNED_INNO_SETUP_VERSION,
    innoInstallerSha256: PINNED_INNO_INSTALLER_SHA256,
    signed: false,
    preInnoInputSha256,
    buildAInstallerSha256: buildASha256,
    buildBInstallerSha256: buildBSha256,
    deterministicBuildsMatch: true,
    lifecycle
  });
}
