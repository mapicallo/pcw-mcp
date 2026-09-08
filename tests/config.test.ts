import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findSharedContext,
  findWorkstream,
  loadPcwConfig,
  PcwConfigError
} from "../src/config/pcw-config.js";
import { fixtureRoot } from "./mcp-test-client.js";

async function withConfig<T>(
  yaml: string,
  run: (contextRoot: string) => Promise<T>
): Promise<T> {
  const contextRoot = await mkdtemp(join(tmpdir(), "pcw-config-test-"));

  try {
    await writeFile(join(contextRoot, "pcw.yml"), yaml, "utf8");
    return await run(contextRoot);
  } finally {
    await rm(contextRoot, { recursive: true, force: true });
  }
}

test("valid pcw.yml parses into a typed configuration", async () => {
  const loaded = await loadPcwConfig(fixtureRoot);

  assert.equal(loaded.config.version, 1);
  assert.equal(loaded.config.project?.id, "sample-pcw");
  assert.equal(loaded.config.inventory?.path, "catalog/inventory.md");
});

test("invalid YAML syntax is rejected with a configuration error", async () => {
  await withConfig("project: [unclosed", async (contextRoot) => {
    await assert.rejects(
      loadPcwConfig(contextRoot),
      (error) =>
        error instanceof PcwConfigError &&
        /Could not parse PCW configuration/.test(error.message)
    );
  });
});

test("structurally invalid pcw.yml is rejected", async () => {
  await withConfig("workstreams: []\n", async (contextRoot) => {
    await assert.rejects(
      loadPcwConfig(contextRoot),
      (error) =>
        error instanceof PcwConfigError &&
        /Invalid PCW configuration/.test(error.message)
    );
  });
});

test("dynamic shared-context names are preserved and resolved", async () => {
  await withConfig(
    "shared_context:\n  team-knowledge:\n    path: arbitrary/location\n",
    async (contextRoot) => {
      const { config } = await loadPcwConfig(contextRoot);
      const shared = findSharedContext(config, "TEAM-KNOWLEDGE");

      assert.deepEqual(Object.keys(config.shared_context ?? {}), [
        "team-knowledge"
      ]);
      assert.equal(shared?.name, "team-knowledge");
      assert.equal(shared?.config.path, "arbitrary/location");
    }
  );
});

test("workstream with context and continuity is accepted", async () => {
  const { config } = await loadPcwConfig(fixtureRoot);
  const backend = findWorkstream(config, "BACKEND");

  assert.equal(backend?.config.context?.path, "engineering/backend-material");
  assert.equal(backend?.config.continuity?.path, "state/BACKEND.md");
});

test("workstream with continuity and no specialized context is accepted", async () => {
  const { config } = await loadPcwConfig(fixtureRoot);
  const operations = findWorkstream(config, "OPERATIONS");

  assert.equal(operations?.config.context, undefined);
  assert.equal(operations?.config.continuity?.path, "state/OPERATIONS.md");
});

test("case-insensitive workstream lookup returns the canonical name", async () => {
  const { config } = await loadPcwConfig(fixtureRoot);

  assert.equal(findWorkstream(config, "  backEND  ")?.name, "BACKEND");
});

test("unknown workstream lookup returns null", async () => {
  const { config } = await loadPcwConfig(fixtureRoot);

  assert.equal(findWorkstream(config, "MISSING"), null);
});

test("malformed or empty path fields are rejected", async () => {
  for (const yaml of [
    "shared_context:\n  general:\n    path: 42\n",
    "shared_context:\n  general:\n    path: ''\n"
  ]) {
    await withConfig(yaml, async (contextRoot) => {
      await assert.rejects(
        loadPcwConfig(contextRoot),
        (error) =>
          error instanceof PcwConfigError &&
          /shared_context\.general\.path/.test(error.message)
      );
    });
  }
});

test("configuration reload reflects file changes without caching", async () => {
  await withConfig(
    "project:\n  name: First Name\n",
    async (contextRoot) => {
      const first = await loadPcwConfig(contextRoot);
      await writeFile(
        join(contextRoot, "pcw.yml"),
        "project:\n  name: Second Name\n",
        "utf8"
      );
      const second = await loadPcwConfig(contextRoot);

      assert.equal(first.config.project?.name, "First Name");
      assert.equal(second.config.project?.name, "Second Name");
    }
  );
});

test("pcw.yml version remains optional and accepts strings or numbers", async () => {
  for (const [yaml, expected] of [
    ["project:\n  id: no-version\n", undefined],
    ["version: 1\n", 1],
    ["version: experimental\n", "experimental"]
  ] as const) {
    await withConfig(yaml, async (contextRoot) => {
      const loaded = await loadPcwConfig(contextRoot);

      assert.equal(loaded.config.version, expected);
    });
  }
});
