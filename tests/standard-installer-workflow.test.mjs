import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const workflowPath = resolve(import.meta.dirname, "..", ".github", "workflows", "standard-windows.yml");

test("Windows installer CI pins and verifies Node and Inno inputs", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /runs-on: windows-latest/u);
  assert.match(workflow, /NODE_VERSION: 22\.23\.3/u);
  assert.match(workflow, /NODE_ZIP_SHA256: 2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71/u);
  assert.match(workflow, /INNO_VERSION: 6\.4\.3/u);
  assert.match(workflow, /INNO_INSTALLER_SHA256: f3c42116542c4cc57263c5ba6c4feabfc49fe771f2f98a79d2f7628b8762723b/u);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256/u);
  assert.doesNotMatch(workflow, /winget|choco|node-version:\s*['"]?latest|download\/latest/iu);
});

test("Windows installer CI uses explicit builders and engineering isolation", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /npm run standard:runtime -- --core-tgz/u);
  assert.match(workflow, /--node-runtime/u);
  assert.match(workflow, /npm run standard:installer -- --runtime-dir/u);
  assert.match(workflow, /--mode engineering/u);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/iu);
});

test("Windows installer CI performs a disposable lifecycle without client mutation", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /\$root = 'C:\\pcw-standard-ci-\$\{\{ github\.run_id \}\}'/u);
  assert.match(workflow, /Proyecto Ágil & QA \(2026\)\\日本語/u);
  assert.match(workflow, /pcw-doctor\.cmd/u);
  assert.match(workflow, /unins000\.exe/u);
  assert.match(workflow, /Uninstall removed the PCW context/u);
  assert.doesNotMatch(workflow, /PCWRemoveOwned=yes/u);
  assert.doesNotMatch(workflow, /--client cursor|--client codex|--client claude-desktop/u);
});

