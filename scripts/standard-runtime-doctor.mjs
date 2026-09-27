import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const timeoutMs = 10_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== "--context-root" || !args[1]?.trim()) {
    throw new Error("Usage: pcw-doctor.cmd --context-root <path>");
  }
  return resolve(args[1]);
}

function execute(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${options.label ?? "Process"} timed out`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${options.label ?? "Process"} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

export function probeMcp(_nodeExecutable, _serverEntry, contextRoot, runtimeRoot) {
  return new Promise((resolvePromise, reject) => {
    const launcher = join(runtimeRoot, "bin", "pcw.cmd");
    const child = spawn(process.env.ComSpec ?? "cmd.exe", [
      "/d", "/s", "/c", "call", launcher, "--context-root", contextRoot
    ], {
      cwd: runtimeRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let probeSucceeded = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("MCP startup probe timed out")), timeoutMs);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (probeSucceeded) resolvePromise();
      else reject(new Error(`MCP server exited early (${code}): ${stderr.trim()}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error("MCP stdout contained non-JSON output")); return; }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        } else if (message.id === 2 && Array.isArray(message.result?.tools)) {
          probeSucceeded = true;
          child.stdin.end();
          child.kill();
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pcw-doctor", version: "1.0.0" } }
    })}\n`);
  });
}

async function defaultDependencyProbe(nodeExecutable, coreDirectory) {
  const probe = "await import('@napi-rs/canvas'); await import('pdf-parse');";
  await execute(nodeExecutable, ["--input-type=module", "-e", probe], {
    cwd: coreDirectory,
    label: "Dependency probe"
  });
}

async function defaultConfigLoader(runtimeRoot, contextRoot) {
  const modulePath = join(runtimeRoot, "core", "dist", "config", "pcw-config.js");
  const { loadPcwConfig } = await import(pathToFileURL(modulePath).href);
  await loadPcwConfig(contextRoot);
}

export async function runDoctor({
  runtimeRoot,
  contextRoot,
  mcpProbe = probeMcp,
  dependencyProbe = defaultDependencyProbe,
  configLoader = defaultConfigLoader
}) {
  const results = [];
  const check = async (label, operation) => {
    try { await operation(); results.push({ label, ok: true }); }
    catch (error) { results.push({ label, ok: false, message: error instanceof Error ? error.message : "Unknown failure" }); }
  };
  let metadata;
  const metadataPath = join(runtimeRoot, "metadata", "standard-runtime.json");
  await check("Runtime metadata", async () => { metadata = JSON.parse(await readFile(metadataPath, "utf8")); });
  await check("Runtime file manifest", async () => {
    const manifest = JSON.parse(
      await readFile(join(runtimeRoot, "metadata", "runtime-files.json"), "utf8")
    );
    for (const file of manifest.files ?? []) {
      const path = join(runtimeRoot, ...file.path.split("/"));
      const bytes = await readFile(path);
      if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) {
        throw new Error(`Installed runtime file differs: ${file.path}`);
      }
    }
  });
  const nodeExecutable = join(runtimeRoot, "runtime", "node.exe");
  await check("Portable Node", async () => {
    await access(nodeExecutable);
    const result = await execute(nodeExecutable, ["--version"], { label: "Portable Node" });
    if (metadata && result.stdout.trim().replace(/^v/, "") !== metadata.node.version) throw new Error("Node version differs from metadata");
  });
  await check("Canonical Core integrity", async () => {
    if (!metadata) throw new Error("Runtime metadata unavailable");
    const artifact = join(runtimeRoot, ...metadata.core.artifact.split("/"));
    if (hash(await readFile(artifact)) !== metadata.core.sha256) throw new Error("Canonical Core TGZ SHA-256 mismatch");
  });
  const corePackagePath = join(runtimeRoot, "core", "package.json");
  await check("Expanded Core", async () => {
    const packageJson = JSON.parse(await readFile(corePackagePath, "utf8"));
    if (!metadata || packageJson.version !== metadata.core.version || packageJson.name !== metadata.core.name) {
      throw new Error("Expanded Core identity differs from metadata");
    }
    const entry = join(runtimeRoot, "core", packageJson.main ?? "dist/server.js");
    if (!(await stat(entry)).isFile()) throw new Error("Core entrypoint is missing");
  });
  await check("Production dependencies", async () => {
    await dependencyProbe(nodeExecutable, join(runtimeRoot, "core"));
  });
  await check("Context root", async () => {
    if (!(await stat(contextRoot)).isDirectory()) throw new Error("Context root is not a directory");
    await access(contextRoot, constants.R_OK | constants.W_OK);
  });
  await check("pcw.yml", async () => {
    await configLoader(runtimeRoot, contextRoot);
  });
  await check("MCP startup", async () => {
    await mcpProbe(
      nodeExecutable,
      join(runtimeRoot, "core", "dist", "server.js"),
      contextRoot,
      runtimeRoot
    );
  });
  return results;
}

async function main() {
  const contextRoot = parseArgs(process.argv.slice(2));
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const results = await runDoctor({ runtimeRoot, contextRoot });
  process.stdout.write("PCW Doctor\n\n");
  for (const result of results) {
    process.stdout.write(`[${result.ok ? "OK" : "FAIL"}] ${result.label}${result.message ? `: ${result.message}` : ""}\n`);
  }
  if (results.every(({ ok }) => ok)) process.stdout.write("\nPCW is ready.\n");
  else process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`PCW Doctor: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
