import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/client/stdio";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);

export const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "sample-context"
);

const serverEntry = join(repositoryRoot, "dist", "server.js");

export type ToolResponse<T> = {
  data: T;
  isError: boolean;
};

export async function withServer<T>(
  contextRoot: string,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      PCW_CONTEXT_ROOT: contextRoot
    },
    stderr: "pipe"
  });

  const client = new Client({
    name: "pcw-characterization-tests",
    version: "1.0.0"
  });

  let serverErrors = "";
  transport.stderr?.on("data", (chunk) => {
    serverErrors += chunk.toString();
  });

  try {
    await client.connect(transport);
    return await run(client);
  } catch (error) {
    if (serverErrors) {
      throw new Error(`${String(error)}\nPCW server stderr:\n${serverErrors}`);
    }
    throw error;
  } finally {
    await client.close();
  }
}

export async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResponse<T>> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find(
    (item): item is { type: "text"; text: string } => item.type === "text"
  );

  if (!text) {
    throw new Error(`Tool '${name}' returned no text content`);
  }

  return {
    data: JSON.parse(text.text) as T,
    isError: result.isError === true
  };
}

export async function withTemporaryContext<T>(
  run: (contextRoot: string) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pcw-mcp-test-"));
  const contextRoot = join(temporaryRoot, "context");

  try {
    await cp(fixtureRoot, contextRoot, { recursive: true });
    return await run(contextRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
