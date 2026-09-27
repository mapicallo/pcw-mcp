import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_INNO_SETUP_VERSION = "6.4.3";
export const PINNED_STANDARD_NODE_VERSION = "22.23.3";
export const PINNED_STANDARD_NODE_ZIP_SHA256 = "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71";
export const PINNED_STANDARD_NPM_VERSION = "11.4.2";
const REPRODUCIBLE_FILE_TIME = new Date("2000-01-01T00:00:00.000Z");
export function prototypeInstallerName(version) {
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/u.test(version)) {
    throw new Error("Standard runtime Core version is not safe for an installer filename");
  }
  return `PCW-Setup-${version}-prototype.exe`;
}

export function officialInstallerName(version) {
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/u.test(version)) {
    throw new Error("Standard runtime Core version is not safe for an installer filename");
  }
  return `PCW-Setup-${version}.exe`;
}

function isDevelopmentVersion(version) {
  return /(?:^|[.-])dev(?:[.-]|$)/iu.test(version);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultScript = join(repositoryRoot, "installer", "windows", "pcw-standard.iss");

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function parseStandardInstallerArgs(args) {
  const names = new Map([
    ["--runtime-dir", "runtimeDir"],
    ["--output-dir", "outputDir"],
    ["--iscc", "iscc"],
    ["--script", "script"],
    ["--mode", "mode"]
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--")) throw new Error(`Invalid or incomplete option: ${args[index]}`);
    if (options[key]) throw new Error(`Repeated option: ${args[index]}`);
    options[key] = value;
  }
  for (const key of ["runtimeDir", "outputDir", "iscc"]) {
    if (!options[key]) throw new Error(`${key} is required`);
    if (!isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
  }
  options.mode ??= "release";
  if (!new Set(["release", "engineering"]).has(options.mode)) {
    throw new Error("mode must be release or engineering");
  }
  return options;
}

export function parseInnoVersion(output) {
  const match = output.match(/(?:Compiler engine version:\s*Inno Setup|Inno Setup(?: 6)? Command-Line Compiler version)\s+([0-9]+\.[0-9]+\.[0-9]+)/iu);
  if (!match) throw new Error("Unable to determine Inno Setup compiler version");
  return match[1];
}

async function validateRuntime(runtimeDir) {
  const metadata = JSON.parse(await readFile(join(runtimeDir, "metadata", "standard-runtime.json"), "utf8"));
  if (metadata?.target?.os !== "windows" || metadata?.target?.arch !== "x64") {
    throw new Error("Installer input must be a Standard windows/x64 runtime");
  }
  if (typeof metadata?.core?.version !== "string" || !/^[a-f0-9]{64}$/u.test(metadata?.core?.sha256 ?? "")) {
    throw new Error("Standard runtime metadata lacks valid Core identity");
  }
  if (!Number.isInteger(metadata.schemaVersion)) throw new Error("Standard runtime schema version is invalid");
  for (const path of [
    join(runtimeDir, "runtime", "node.exe"),
    join(runtimeDir, "bin", "pcw.cmd"),
    join(runtimeDir, "core", "standard-tools", "standard-setup.mjs"),
    join(runtimeDir, "metadata", "runtime-files.json")
  ]) {
    if (!(await stat(path)).isFile()) throw new Error(`Standard runtime input is incomplete: ${path}`);
  }
  return metadata;
}

async function fingerprintTree(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  const records = [];
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) records.push(...await fingerprintTree(root, relativePath));
    else if (entry.isFile()) {
      const path = join(root, relativePath);
      const metadata = await stat(path);
      records.push({
        path: relativePath.replaceAll("\\", "/"),
        sizeBytes: metadata.size,
        mtimeMs: Math.trunc(metadata.mtimeMs),
        sha256: createHash("sha256").update(await readFile(path)).digest("hex")
      });
    } else {
      throw new Error(`Standard runtime contains unsupported filesystem entry: ${relativePath}`);
    }
  }
  return records;
}

async function preInnoFingerprint(runtime, script, installerMetadata) {
  const input = {
    runtime: await fingerprintTree(runtime),
    script: createHash("sha256").update(await readFile(script)).digest("hex"),
    installerMetadata: createHash("sha256").update(await readFile(installerMetadata)).digest("hex"),
    installerMetadataMtime: Math.trunc((await stat(installerMetadata)).mtimeMs)
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function buildStandardWindowsInstaller({
  runtimeDir,
  outputDir,
  iscc,
  script = defaultScript,
  mode = "release",
  execute = run
}) {
  if (!new Set(["release", "engineering"]).has(mode)) {
    throw new Error("mode must be release or engineering");
  }
  const runtime = resolve(runtimeDir);
  const output = resolve(outputDir);
  const compiler = resolve(iscc);
  const temporary = await mkdtemp(join(tmpdir(), "pcw-standard-installer-"));
  try {
    const versionProbe = join(temporary, "version-probe.iss");
    await writeFile(versionProbe, [
      "[Setup]",
      "AppName=PCW Compiler Probe",
      "AppVersion=0",
      "DefaultDirName={tmp}\\PCW-Compiler-Probe",
      "Uninstallable=no",
      "CreateAppDir=no",
      ""
    ].join("\n"), "utf8");
    const versionOutput = execute(compiler, [
      `/O${temporary}`,
      "/Fpcw-inno-version-probe",
      versionProbe
    ], "Inno Setup version check");
    const compilerVersion = parseInnoVersion(versionOutput);
    if (compilerVersion !== PINNED_INNO_SETUP_VERSION) {
      throw new Error(`Inno Setup ${PINNED_INNO_SETUP_VERSION} is required, received ${compilerVersion}`);
    }
    const metadata = await validateRuntime(runtime);
    if (mode === "release") {
      if (isDevelopmentVersion(metadata.core.version)) {
        throw new Error("Official Standard installer refuses development software versions");
      }
      if (metadata.node?.version !== PINNED_STANDARD_NODE_VERSION ||
          metadata.node?.inputType !== "zip" ||
          metadata.node?.inputSha256 !== PINNED_STANDARD_NODE_ZIP_SHA256 ||
          metadata.build?.npmVersion !== PINNED_STANDARD_NPM_VERSION) {
        throw new Error("Official Standard installer requires the pinned Node/npm runtime inputs");
      }
    }
    await mkdir(output, { recursive: true });
    const installerMetadata = join(temporary, "installer.json");
    await writeFile(installerMetadata, `${JSON.stringify({
      schemaVersion: 1,
      productId: mode === "engineering"
        ? "pcw-standard-windows-installer-prototype"
        : "pcw-standard-windows-installer",
      softwareVersion: metadata.core.version,
      coreTgzSha256: metadata.core.sha256,
      runtimeSchemaVersion: metadata.schemaVersion,
      target: { os: "windows", arch: "x64" },
      releaseGrade: false,
      signed: false
    }, null, 2)}\n`, "utf8");
    await utimes(installerMetadata, REPRODUCIBLE_FILE_TIME, REPRODUCIBLE_FILE_TIME);
    const inputFingerprint = await preInnoFingerprint(runtime, resolve(script), installerMetadata);
    const compileArguments = [
      `/DRuntimeDir=${runtime}`,
      `/DOutputDir=${output}`,
      `/DAppVersion=${metadata.core.version}`,
      `/DCoreSha256=${metadata.core.sha256}`,
      `/DRuntimeSchemaVersion=${metadata.schemaVersion}`,
      `/DInstallerMetadataFile=${installerMetadata}`
    ];
    if (mode === "engineering") compileArguments.push("/DPcwEngineeringBuild=1");
    compileArguments.push(resolve(script));
    execute(compiler, compileArguments, "Inno Setup compilation");
    const installer = join(output, mode === "engineering"
      ? prototypeInstallerName(metadata.core.version)
      : officialInstallerName(metadata.core.version));
    if (!(await stat(installer)).isFile()) throw new Error(`Expected installer was not produced: ${installer}`);
    return {
      installer,
      compilerVersion,
      metadata,
      inputFingerprint,
      installerSha256: createHash("sha256").update(await readFile(installer)).digest("hex")
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseStandardInstallerArgs(process.argv.slice(2));
    const result = await buildStandardWindowsInstaller(options);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      installer: result.installer,
      compilerVersion: result.compilerVersion,
      prototype: options.mode === "engineering",
      inputFingerprint: result.inputFingerprint,
      installerSha256: result.installerSha256
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown installer build failure"
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
