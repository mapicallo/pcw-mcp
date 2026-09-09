import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("verify:beta must be run through npm");
}

const checks = [
  ["run", "build"],
  ["test"],
  ["run", "test:package-install"],
  ["pack", "--dry-run", "--json"]
];

for (const args of checks) {
  process.stdout.write(`\n[verify:beta] npm ${args.join(" ")}\n`);
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("\n[verify:beta] all release-candidate checks passed\n");
