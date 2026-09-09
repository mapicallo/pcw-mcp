import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expectedFiles = [
  "dist",
  "README.md",
  "docs/public-contract.md",
  "docs/mcp-tools.md",
  "docs/pcw-yml.md",
  "docs/pcw-model.md",
  "docs/runtime.md",
  "docs/security.md"
];

type PackageManifest = {
  private?: boolean;
  files?: string[];
};

type PackFile = {
  path: string;
};

type PackResult = {
  files: PackFile[];
};

test("package manifest defines a private explicit distribution allowlist", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8")
  ) as PackageManifest;

  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.files, expectedFiles);
});

test("npm pack dry-run excludes development and private-beta state", async () => {
  const command = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json"]
    : ["pack", "--dry-run", "--json"];
  const { stdout } = await execFileAsync(command, args, {
    cwd: repositoryRoot,
    maxBuffer: 1024 * 1024
  });
  const results = JSON.parse(stdout) as PackResult[];
  assert.equal(results.length, 1);

  const paths = results[0].files.map((file) => file.path);
  assert.ok(paths.includes("package.json"));
  assert.ok(paths.includes("dist/server.js"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("docs/runtime.md"));
  assert.equal(paths.some((path) => path.startsWith("src/")), false);
  assert.equal(paths.some((path) => path.startsWith("tests/")), false);
  assert.equal(paths.includes("CONTINUITY.md"), false);
  assert.equal(paths.includes("docs/roadmap.md"), false);
  assert.equal(paths.includes("docs/v0.1-poc-validation.md"), false);
  assert.equal(paths.some((path) => path.startsWith(".git/")), false);
  assert.equal(paths.some((path) => path.startsWith(".cursor/")), false);
});
