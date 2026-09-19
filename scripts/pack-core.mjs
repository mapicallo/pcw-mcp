import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function packCoreTarball(repositoryRoot, destination, version, { alreadyBuilt = false } = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Core packaging must be run through npm");
  if (!alreadyBuilt) {
    const build = spawnSync(process.execPath, [npmCli, "run", "build"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit"
    });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error("Core build failed before npm pack");
  }
  const args = ["pack", "--json", "--pack-destination", destination];
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: "pipe"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  const [packResult] = JSON.parse(result.stdout);
  const expected = `pcw-mcp-${version}.tgz`;
  if (packResult?.filename !== expected) {
    throw new Error(`Unexpected npm artifact: ${packResult?.filename ?? "(missing)"}`);
  }
  return join(destination, expected);
}
