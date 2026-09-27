import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleStandardWindowsRuntime, parseStandardRuntimeArgs } from "./standard-runtime.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = parseStandardRuntimeArgs(process.argv.slice(2));
  const result = await assembleStandardWindowsRuntime({
    ...options,
    packageLock: options.packageLock ?? join(repositoryRoot, "package-lock.json"),
    npmCli: options.npmCli ?? process.env.npm_execpath,
    doctorSource: join(repositoryRoot, "scripts", "standard-runtime-doctor.mjs")
  });
  process.stdout.write(`${result.output}\n`);
} catch (error) {
  process.stderr.write(`standard:runtime: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
}
