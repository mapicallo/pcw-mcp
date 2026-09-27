import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { unzipSync } from "fflate";

export const STANDARD_RUNTIME_SCHEMA_VERSION = 1;

const WINDOWS_LAUNCHER = `@echo off\r\nsetlocal\r\nset "PCW_HOME=%~dp0.."\r\nset "PCW_NODE=%PCW_HOME%\\runtime\\node.exe"\r\nif not exist "%PCW_NODE%" (\r\n  >&2 echo PCW runtime error: portable node.exe is missing.\r\n  exit /b 1\r\n)\r\n"%PCW_NODE%" "%PCW_HOME%\\core\\dist\\server.js" %*\r\nexit /b %ERRORLEVEL%\r\n`;

const WINDOWS_DOCTOR_LAUNCHER = `@echo off\r\nsetlocal\r\nset "PCW_HOME=%~dp0.."\r\nset "PCW_NODE=%PCW_HOME%\\runtime\\node.exe"\r\nif not exist "%PCW_NODE%" (\r\n  >&2 echo PCW Doctor error: portable node.exe is missing.\r\n  exit /b 1\r\n)\r\n"%PCW_NODE%" "%PCW_HOME%\\tools\\doctor.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isSameOrInside(base, candidate) {
  const path = relative(base, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : "pipe"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${options.label ?? command} failed${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

function validatePackageIdentity(packageJson, lockJson) {
  const locked = lockJson?.packages?.[""];
  if (!locked || lockJson.lockfileVersion !== 3) {
    throw new Error("package-lock must be npm lockfileVersion 3 with a root package");
  }
  for (const field of ["name", "version"]) {
    if (locked[field] !== packageJson[field]) {
      throw new Error(`package-lock ${field} does not match Core package.json`);
    }
  }
  if (JSON.stringify(locked.dependencies ?? {}) !== JSON.stringify(packageJson.dependencies ?? {})) {
    throw new Error("package-lock production dependencies do not match Core package.json");
  }
}

async function extractCoreTarball(coreTgz, coreDirectory) {
  const entries = run("tar", ["-tzf", coreTgz], { label: "Core archive inspection" })
    .split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return !normalized.startsWith("package/") || normalized.includes("/../") ||
      normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized);
  })) {
    throw new Error("Core archive contains an unsafe or unexpected entry");
  }
  await mkdir(coreDirectory, { recursive: true });
  run("tar", ["-xzf", coreTgz, "--strip-components", "1", "-C", coreDirectory], {
    label: "Core archive extraction"
  });
}

async function locateNodeDirectory(input) {
  const info = await stat(input);
  if (!info.isDirectory()) throw new Error("Node runtime input must be a directory or .zip archive");
  if ((await readdir(input)).includes("node.exe")) return input;
  const children = await readdir(input, { withFileTypes: true });
  const candidates = [];
  for (const child of children) {
    if (child.isDirectory() && (await readdir(join(input, child.name))).includes("node.exe")) {
      candidates.push(join(input, child.name));
    }
  }
  if (candidates.length !== 1) throw new Error("Node runtime directory must contain one node.exe");
  return candidates[0];
}

async function copyNodeRuntime(input, destination) {
  await mkdir(destination, { recursive: true });
  let sourceRoot;
  let inputSha256;
  let inputType;
  if (extname(input).toLowerCase() === ".zip") {
    const bytes = await readFile(input);
    const entries = unzipSync(new Uint8Array(bytes));
    const nodeNames = Object.keys(entries).filter((name) => /(^|\/)node\.exe$/i.test(name));
    if (nodeNames.length !== 1) throw new Error("Node archive must contain exactly one node.exe");
    const root = nodeNames[0].slice(0, -"node.exe".length);
    const selected = Object.keys(entries).filter((name) =>
      name === `${root}node.exe` || (name.startsWith(root) && !name.slice(root.length).includes("/") && /\.dll$/i.test(name))
    );
    for (const name of selected) await writeFile(join(destination, basename(name)), entries[name]);
    inputSha256 = sha256(bytes);
    inputType = "zip";
  } else {
    sourceRoot = await locateNodeDirectory(input);
    const names = (await readdir(sourceRoot)).filter((name) =>
      name.toLowerCase() === "node.exe" || extname(name).toLowerCase() === ".dll"
    ).sort();
    if (!names.some((name) => name.toLowerCase() === "node.exe")) {
      throw new Error("Node runtime input lacks node.exe");
    }
    const descriptor = [];
    for (const name of names) {
      const bytes = await readFile(join(sourceRoot, name));
      await writeFile(join(destination, name), bytes);
      descriptor.push(`${name}:${sha256(bytes)}`);
    }
    inputSha256 = sha256(descriptor.join("\n"));
    inputType = "directory";
  }
  const executable = join(destination, "node.exe");
  const nodeVersion = run(executable, ["--version"], { label: "Portable Node version check" });
  const architecture = run(executable, ["-p", "process.arch"], { label: "Portable Node architecture check" });
  if (architecture !== "x64") throw new Error(`Portable Node must target x64, received ${architecture}`);
  return { executable, nodeVersion: nodeVersion.replace(/^v/, ""), architecture, inputSha256, inputType };
}

async function defaultInstallDependencies({ coreDirectory, npmCli }) {
  run(process.execPath, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: coreDirectory,
    label: "Production dependency installation",
    inherit: true
  });
}

async function defaultVerifyDependencies({ nodeExecutable, coreDirectory }) {
  const probe = join(coreDirectory, ".pcw-standard-dependency-probe.mjs");
  await writeFile(probe, "await import('@napi-rs/canvas');\nawait import('pdf-parse');\n", "utf8");
  try {
    run(nodeExecutable, [probe], { cwd: coreDirectory, label: "Production dependency probe" });
  } finally {
    await rm(probe, { force: true });
  }
}

async function collectFiles(root, prefix = "") {
  const files = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (relativePath.replaceAll("\\", "/") === "metadata/runtime-files.json") continue;
    if (entry.isDirectory()) files.push(...await collectFiles(root, relativePath));
    else if (entry.isFile()) {
      const absolutePath = join(root, relativePath);
      files.push({
        path: relativePath.split(sep).join("/"),
        sizeBytes: (await stat(absolutePath)).size,
        sha256: await sha256File(absolutePath)
      });
    }
  }
  return files;
}

async function replaceDirectory(stage, output) {
  const parent = dirname(output);
  const previous = `${output}.previous`;
  await rm(previous, { recursive: true, force: true });
  try {
    const current = await lstat(output);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error("Standard runtime output must be a regular directory");
    }
    await rename(output, previous);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(stage, output);
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    try { await rename(previous, output); } catch {}
    throw error;
  }
  await mkdir(parent, { recursive: true });
}

export async function assembleStandardWindowsRuntime({
  coreTgz,
  nodeRuntime,
  output,
  packageLock,
  npmCli,
  expectedNodeVersion,
  doctorSource,
  installDependencies = defaultInstallDependencies,
  verifyDependencies = defaultVerifyDependencies
}) {
  for (const [name, value] of Object.entries({ coreTgz, nodeRuntime, output, packageLock, npmCli, doctorSource })) {
    if (!value) throw new Error(`${name} is required`);
  }
  const outputPath = resolve(output);
  if (dirname(outputPath) === outputPath) throw new Error("Standard runtime output cannot be a filesystem root");
  for (const input of [coreTgz, nodeRuntime, packageLock, npmCli, doctorSource]) {
    if (isSameOrInside(outputPath, resolve(input))) {
      throw new Error("Standard runtime output cannot contain a build input");
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const stage = await mkdtemp(join(dirname(outputPath), ".pcw-standard-runtime-"));
  try {
    const coreHash = await sha256File(coreTgz);
    const lockHash = await sha256File(packageLock);
    const packageDirectory = join(stage, "package");
    const coreDirectory = join(stage, "core");
    const runtimeDirectory = join(stage, "runtime");
    const metadataDirectory = join(stage, "metadata");
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(metadataDirectory, { recursive: true });
    await copyFile(coreTgz, join(packageDirectory, basename(coreTgz)));
    if (await sha256File(join(packageDirectory, basename(coreTgz))) !== coreHash) {
      throw new Error("Copied canonical Core TGZ differs from input");
    }
    await extractCoreTarball(resolve(coreTgz), coreDirectory);
    const packageJson = JSON.parse(await readFile(join(coreDirectory, "package.json"), "utf8"));
    const lockJson = JSON.parse(await readFile(packageLock, "utf8"));
    validatePackageIdentity(packageJson, lockJson);
    await copyFile(packageLock, join(coreDirectory, "package-lock.json"));

    const node = await copyNodeRuntime(resolve(nodeRuntime), runtimeDirectory);
    if (expectedNodeVersion && node.nodeVersion !== expectedNodeVersion.replace(/^v/, "")) {
      throw new Error(`Portable Node version ${node.nodeVersion} does not match expected ${expectedNodeVersion}`);
    }
    const npmVersion = run(process.execPath, [npmCli, "--version"], { label: "npm version check" });
    await installDependencies({ coreDirectory, npmCli, nodeExecutable: node.executable });
    await verifyDependencies({ coreDirectory, nodeExecutable: node.executable });

    await mkdir(join(stage, "bin"), { recursive: true });
    await mkdir(join(stage, "tools"), { recursive: true });
    await writeFile(join(stage, "bin", "pcw.cmd"), WINDOWS_LAUNCHER, "utf8");
    await writeFile(join(stage, "bin", "pcw-doctor.cmd"), WINDOWS_DOCTOR_LAUNCHER, "utf8");
    await copyFile(doctorSource, join(stage, "tools", "doctor.mjs"));

    const metadata = {
      schemaVersion: STANDARD_RUNTIME_SCHEMA_VERSION,
      productId: "pcw-standard-windows-runtime",
      target: { os: "windows", arch: "x64" },
      core: {
        name: packageJson.name,
        version: packageJson.version,
        artifact: `package/${basename(coreTgz)}`,
        sha256: coreHash,
        packageLockSha256: lockHash
      },
      node: {
        version: node.nodeVersion,
        inputType: node.inputType,
        inputSha256: node.inputSha256
      },
      build: { npmVersion }
    };
    await writeFile(join(metadataDirectory, "standard-runtime.json"), stableJson(metadata));
    await writeFile(join(metadataDirectory, "core-sha256.txt"), `${coreHash}  ${basename(coreTgz)}\n`);
    await writeFile(join(metadataDirectory, "node-runtime.json"), stableJson(metadata.node));
    await writeFile(join(metadataDirectory, "runtime-files.json"), stableJson({
      schemaVersion: 1,
      files: await collectFiles(stage)
    }));
    await replaceDirectory(stage, outputPath);
    return { output: outputPath, metadata };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export function parseStandardRuntimeArgs(args) {
  const options = {};
  const names = new Map([
    ["--core-tgz", "coreTgz"],
    ["--node-runtime", "nodeRuntime"],
    ["--output", "output"],
    ["--package-lock", "packageLock"],
    ["--npm-cli", "npmCli"],
    ["--expected-node-version", "expectedNodeVersion"]
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--")) throw new Error(`Invalid or incomplete option: ${args[index]}`);
    if (options[key]) throw new Error(`Repeated option: ${args[index]}`);
    options[key] = value;
  }
  return options;
}
