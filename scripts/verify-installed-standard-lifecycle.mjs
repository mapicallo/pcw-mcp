import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/client/stdio";

function parseArgs(args) {
  const options = {};
  const names = new Map([
    ["--installer", "installer"],
    ["--launcher", "launcher"],
    ["--context-root", "contextRoot"],
    ["--output", "output"]
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--")) {
      throw new Error(`Invalid or incomplete option: ${args[index]}`);
    }
    if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
    options[key] = value;
  }
  for (const key of names.values()) if (!options[key]) throw new Error(`${key} is required`);
  return options;
}

export async function verifyInstalledStandardLifecycle({
  installer,
  launcher,
  contextRoot
}) {
  const installerSha256 = createHash("sha256")
    .update(await readFile(resolve(installer)))
    .digest("hex");
  const transport = new StdioClientTransport({
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", "call", resolve(launcher), "--context-root", resolve(contextRoot)],
    env: getDefaultEnvironment(),
    stderr: "pipe"
  });
  const client = new Client({ name: "pcw-standard-installer-lifecycle", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length !== 16) {
      throw new Error(`Expected 16 MCP tools, received ${tools.tools.length}`);
    }
    const created = await client.callTool({
      name: "create_workstream",
      arguments: {
        name: "STANDARD-INSTALLER-CI",
        mode: "with-context",
        initialObjective: "Synthetic Standard installer lifecycle verification."
      }
    });
    if (created.isError) throw new Error("create_workstream returned an MCP error");
    return {
      installerSha256,
      passed: true,
      mcpToolCount: tools.tools.length,
      workstreamCreated: true,
      realClientConfigUsed: false
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await verifyInstalledStandardLifecycle(options);
  await writeFile(resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`standard:lifecycle: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
