import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PINNED_INNO_SETUP_VERSION = "6.4.3";
export function prototypeInstallerName(version) {
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/u.test(version)) {
    throw new Error("Standard runtime Core version is not safe for an installer filename");
  }
  return `PCW-Setup-${version}-prototype.exe`;
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
    ["--script", "script"]
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
  return options;
}

export function parseInnoVersion(output) {
  const match = output.match(/Inno Setup(?: 6)? Command-Line Compiler version ([0-9]+\.[0-9]+\.[0-9]+)/iu);
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

export async function buildStandardWindowsInstaller({
  runtimeDir,
  outputDir,
  iscc,
  script = defaultScript,
  execute = run
}) {
  const runtime = resolve(runtimeDir);
  const output = resolve(outputDir);
  const compiler = resolve(iscc);
  const versionOutput = execute(compiler, ["/?"], "Inno Setup version check");
  const compilerVersion = parseInnoVersion(versionOutput);
  if (compilerVersion !== PINNED_INNO_SETUP_VERSION) {
    throw new Error(`Inno Setup ${PINNED_INNO_SETUP_VERSION} is required, received ${compilerVersion}`);
  }
  const metadata = await validateRuntime(runtime);
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "pcw-standard-installer-"));
  try {
    const installerMetadata = join(temporary, "installer.json");
    await writeFile(installerMetadata, `${JSON.stringify({
      schemaVersion: 1,
      productId: "pcw-standard-windows-installer-prototype",
      softwareVersion: metadata.core.version,
      coreTgzSha256: metadata.core.sha256,
      runtimeSchemaVersion: metadata.schemaVersion,
      target: { os: "windows", arch: "x64" },
      releaseGrade: false,
      signed: false
    }, null, 2)}\n`, "utf8");
    execute(compiler, [
      `/DRuntimeDir=${runtime}`,
      `/DOutputDir=${output}`,
      `/DAppVersion=${metadata.core.version}`,
      `/DCoreSha256=${metadata.core.sha256}`,
      `/DRuntimeSchemaVersion=${metadata.schemaVersion}`,
      `/DInstallerMetadataFile=${installerMetadata}`,
      resolve(script)
    ], "Inno Setup compilation");
    const installer = join(output, prototypeInstallerName(metadata.core.version));
    if (!(await stat(installer)).isFile()) throw new Error(`Expected installer was not produced: ${installer}`);
    return { installer, compilerVersion, metadata };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await buildStandardWindowsInstaller(parseStandardInstallerArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      installer: result.installer,
      compilerVersion: result.compilerVersion,
      prototype: true
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
