import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const channels = ["private-beta", "beta", "stable"];
const identifier = z.string().regex(/^[a-z][a-z0-9-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const softwareVersionSchema = z.string().regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
);
const targetSchema = z.object({
  os: z.enum(["any", "windows", "macos", "linux"]),
  arch: z.enum(["any", "x64", "arm64"])
}).strict();
const runtimeSchema = z.object({
  node: z.string().min(1)
}).strict();

export const artifactDescriptorSchema = z.object({
  artifactId: identifier,
  type: identifier,
  file: z.string().min(1),
  target: targetSchema.optional(),
  runtime: runtimeSchema.optional()
}).strict();

export const descriptorSchema = z.object({
  artifacts: z.array(artifactDescriptorSchema).min(1)
}).strict();

export const releaseManifestSchema = z.object({
  manifestSchemaVersion: z.literal(1),
  productId: identifier,
  softwareVersion: softwareVersionSchema,
  channel: z.enum(channels),
  source: z.object({
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
    gitTag: z.string().nullable(),
    dirty: z.boolean()
  }).strict(),
  releasedAt: z.string().refine((value) => {
    const date = new Date(value);
    return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
  }, "releasedAt must be a canonical UTC ISO-8601 timestamp").optional(),
  artifacts: z.array(z.object({
    artifactId: identifier,
    type: identifier,
    fileName: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256,
    target: targetSchema.optional(),
    runtime: runtimeSchema.optional()
  }).strict()).min(1)
}).strict();

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    throw new Error(`Git provenance unavailable: git ${args.join(" ")}`);
  }
}

function readJson(content, label) {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${label}`);
  }
}

function validate(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid ${label}: ${issue.path.join(".") || "(root)"} ${issue.message}`);
  }
  return result.data;
}

function gitProvenance(root, version, releaseGrade) {
  const gitCommit = git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(gitCommit)) {
    throw new Error("Git HEAD is not a full commit SHA");
  }
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"]) !== "";
  const expectedTag = `v${version}`;
  const tags = git(root, ["tag", "--points-at", "HEAD", "--list", expectedTag])
    .split(/\r?\n/);
  const tagged = tags.includes(expectedTag) &&
    git(root, ["cat-file", "-t", `refs/tags/${expectedTag}`]) === "tag";
  const gitTag = !dirty && tagged ? expectedTag : null;
  if (releaseGrade && (dirty || !gitTag)) {
    throw new Error("Release-grade manifest requires a clean tree and matching annotated version tag");
  }
  return { gitCommit, gitTag, dirty };
}

async function inspectArtifact(path) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`Artifact not found: ${path}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`Artifact is not a file: ${path}`);
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  const after = await stat(path);
  if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs ||
      sizeBytes !== metadata.size) {
    throw new Error(`Artifact changed while hashing: ${path}`);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

export async function createReleaseManifest({
  repositoryRoot,
  channel,
  descriptorPath,
  releaseGrade = false,
  releasedAt
}) {
  const root = resolve(repositoryRoot);
  const packagePath = resolve(root, "package.json");
  const packageJson = readJson(await readFile(packagePath, "utf8"), packagePath);
  const productId = validate(identifier, packageJson.name, "package name");
  const softwareVersion = validate(softwareVersionSchema, packageJson.version, "package version");
  const validatedChannel = validate(z.enum(channels), channel, "channel");
  const source = gitProvenance(root, softwareVersion, releaseGrade);
  if (releaseGrade && releasedAt === undefined) {
    throw new Error("Release-grade manifest requires explicit --released-at");
  }

  const resolvedDescriptor = resolve(descriptorPath);
  const descriptor = validate(
    descriptorSchema,
    readJson(await readFile(resolvedDescriptor, "utf8"), resolvedDescriptor),
    "artifact descriptor"
  );
  const ids = new Set();
  const artifacts = [];
  for (const item of descriptor.artifacts) {
    if (ids.has(item.artifactId)) {
      throw new Error(`Duplicate artifact ID: ${item.artifactId}`);
    }
    ids.add(item.artifactId);
    const artifactPath = isAbsolute(item.file)
      ? item.file
      : resolve(dirname(resolvedDescriptor), item.file);
    const bytes = await inspectArtifact(artifactPath);
    artifacts.push({
      artifactId: item.artifactId,
      type: item.type,
      fileName: basename(artifactPath),
      ...bytes,
      ...(item.target ? { target: item.target } : {}),
      ...(item.runtime ? { runtime: item.runtime } : {})
    });
  }
  artifacts.sort((left, right) =>
    left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0
  );

  return validate(releaseManifestSchema, {
    manifestSchemaVersion: 1,
    productId,
    softwareVersion,
    channel: validatedChannel,
    source,
    ...(releasedAt === undefined ? {} : { releasedAt }),
    artifacts
  }, "release manifest");
}

export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(validate(releaseManifestSchema, manifest, "release manifest"), null, 2)}\n`;
}

export function validateOutputLocation(repositoryRoot, outputPath, releaseGrade) {
  if (!releaseGrade) return;
  const root = resolve(repositoryRoot);
  const output = resolve(outputPath);
  const within = relative(root, output);
  if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) return;
  const ignored = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', output]);
  if (ignored.error || ignored.status !== 0) {
    throw new Error('Release-grade output inside the repository must be Git-ignored');
  }
}

function parseArgs(args) {
  const options = { releaseGrade: false };
  const flags = new Map([
    ["--channel", "channel"],
    ["--descriptor", "descriptorPath"],
    ["--output", "outputPath"],
    ["--released-at", "releasedAt"]
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--release" && !options.releaseGrade) {
      options.releaseGrade = true;
    } else if (flags.has(arg) && args[index + 1] && !args[index + 1].startsWith("--")) {
      const key = flags.get(arg);
      if (options[key] !== undefined) throw new Error(`Repeated option: ${arg}`);
      options[key] = args[++index];
    } else {
      throw new Error(`Invalid or incomplete option: ${arg}`);
    }
  }
  for (const key of ["channel", "descriptorPath", "outputPath"]) {
    if (!options[key]) throw new Error(`Missing required option: ${key}`);
  }
  return options;
}

async function main() {
  const { outputPath, ...options } = parseArgs(process.argv.slice(2));
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = await createReleaseManifest({ repositoryRoot, ...options });
  const output = resolve(outputPath);
  validateOutputLocation(repositoryRoot, output, options.releaseGrade);
  const descriptor = resolve(options.descriptorPath);
  const artifactFiles = JSON.parse(await readFile(descriptor, "utf8")).artifacts;
  if (artifactFiles.some((item) => resolve(dirname(descriptor), item.file) === output)) {
    throw new Error("Manifest output must not overwrite an input artifact");
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serializeReleaseManifest(manifest), "utf8");
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`release:manifest: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
