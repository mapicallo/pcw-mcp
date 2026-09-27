import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(args) {
  const options = {};
  const names = new Map([
    ["--build-a", "buildA"],
    ["--build-b", "buildB"],
    ["--output", "output"]
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--")) {
      throw new Error(`Invalid or incomplete option: ${args[index]}`);
    }
    options[key] = value;
  }
  for (const key of names.values()) if (!options[key]) throw new Error(`${key} is required`);
  return options;
}

async function readBuildReport(path) {
  const report = JSON.parse((await readFile(resolve(path), "utf8")).replace(/^\uFEFF/u, ""));
  if (report.ok !== true || typeof report.installer !== "string" ||
      !/^[a-f0-9]{64}$/u.test(report.inputFingerprint ?? "") ||
      !/^[a-f0-9]{64}$/u.test(report.installerSha256 ?? "")) {
    throw new Error("Invalid Standard installer build report");
  }
  const bytes = await readFile(resolve(report.installer));
  if (sha256(bytes) !== report.installerSha256) {
    throw new Error("Standard installer changed after its build report");
  }
  return { report, bytes };
}

export async function verifyStandardInstallerReproducibility(buildAPath, buildBPath) {
  const [buildA, buildB] = await Promise.all([
    readBuildReport(buildAPath),
    readBuildReport(buildBPath)
  ]);
  if (buildA.report.inputFingerprint !== buildB.report.inputFingerprint) {
    throw new Error("Pre-Inno input fingerprints differ");
  }
  if (!buildA.bytes.equals(buildB.bytes)) {
    throw new Error("Unsigned Standard installer builds are not byte-identical");
  }
  return {
    schemaVersion: 1,
    deterministicBuildsMatch: true,
    preInnoInputSha256: buildA.report.inputFingerprint,
    installerSha256: buildA.report.installerSha256,
    sizeBytes: buildA.bytes.length
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await verifyStandardInstallerReproducibility(options.buildA, options.buildB);
  await writeFile(resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`standard:reproducibility: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
