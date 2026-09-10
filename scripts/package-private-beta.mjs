import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const version = manifest.version;
const bundleName = `PCW-MCP-${version}-PRIVATE-BETA`;
const outputRoot = resolve(repositoryRoot, "artifacts", "private-beta");
const outputDirectory = resolve(outputRoot, version);
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error("package:private-beta must be run through npm");
}
if (manifest.private !== true || manifest.license !== "UNLICENSED") {
  throw new Error("Private beta packaging requires private=true and license=UNLICENSED");
}
if (relative(outputRoot, outputDirectory).startsWith("..")) {
  throw new Error("Artifact output escaped the configured output root");
}

function runNpm(args, options = {}) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...options.environment },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: options.capture ? "pipe" : "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    throw new Error(`npm ${args.join(" ")} failed\n${output}`);
  }
  return result.stdout ?? "";
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function collectZipFiles(directory, prefix, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const source = join(directory, entry.name);
    const archivePath = `${prefix}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await collectZipFiles(source, archivePath, output);
    } else if (entry.isFile()) {
      output[archivePath] = new Uint8Array(await readFile(source));
    } else {
      throw new Error(`Unsupported staging entry: ${source}`);
    }
  }
}

process.stdout.write("[package:private-beta] verifying release candidate\n");
runNpm(["run", "verify:beta"]);

const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-private-beta-build-"));
try {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const bundleRoot = join(temporaryRoot, bundleName);
  const packageDirectory = join(bundleRoot, "package");
  const docsDirectory = join(bundleRoot, "docs");
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(docsDirectory, { recursive: true });

  const packOutput = runNpm(
    ["pack", "--json", "--pack-destination", packageDirectory],
    { capture: true }
  );
  const [packResult] = JSON.parse(packOutput);
  const tarballPath = join(packageDirectory, packResult.filename);
  const expectedTarball = `pcw-mcp-${version}.tgz`;
  if (packResult.filename !== expectedTarball) {
    throw new Error(`Unexpected npm artifact: ${packResult.filename}`);
  }

  await cp(join(repositoryRoot, "docs", "START-HERE.md"), join(bundleRoot, "START-HERE.md"));
  await cp(
    join(repositoryRoot, "PRIVATE-BETA-TERMS.md"),
    join(bundleRoot, "PRIVATE-BETA-TERMS.md")
  );
  await cp(
    join(repositoryRoot, "examples", "sample-context"),
    join(bundleRoot, "sample-context"),
    { recursive: true }
  );

  for (const document of ["private-beta.md", "runtime.md", "pcw-yml.md", "mcp-tools.md"]) {
    await cp(join(repositoryRoot, "docs", document), join(docsDirectory, document));
  }

  const checksumTargets = [
    `package/${expectedTarball}`,
    "START-HERE.md",
    "PRIVATE-BETA-TERMS.md"
  ];
  const checksumLines = [];
  for (const target of checksumTargets) {
    checksumLines.push(`${sha256(await readFile(join(bundleRoot, target)))}  ${target}`);
  }
  await writeFile(
    join(bundleRoot, "SHA256SUMS.txt"),
    `${checksumLines.join("\n")}\n`,
    "utf8"
  );

  const archiveEntries = {};
  await collectZipFiles(bundleRoot, bundleName, archiveEntries);
  const zipPath = join(outputDirectory, `${bundleName}.zip`);
  const zipContent = Buffer.from(zipSync(archiveEntries, { level: 9 }));
  await writeFile(zipPath, zipContent);

  const zipHash = sha256(zipContent);
  const checksumPath = `${zipPath}.sha256`;
  await writeFile(checksumPath, `${zipHash}  ${basename(zipPath)}\n`, "utf8");

  process.stdout.write("[package:private-beta] verifying extracted handoff\n");
  runNpm(["exec", "--", "tsx", "--test", "tests/handoff.test.ts"], {
    environment: {
      PCW_HANDOFF_ZIP: zipPath,
      PCW_HANDOFF_VERSION: version
    }
  });

  const tarballInfo = await stat(tarballPath);
  const zipInfo = await stat(zipPath);
  process.stdout.write(
    `${JSON.stringify({
      zipPath,
      checksumPath,
      tarball: expectedTarball,
      tarballSize: tarballInfo.size,
      tarballSha256: checksumLines[0].split("  ")[0],
      zipSize: zipInfo.size,
      zipSha256: zipHash
    }, null, 2)}\n`
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
