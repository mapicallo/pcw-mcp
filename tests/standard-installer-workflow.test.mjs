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
  assert.match(workflow, /NPM_VERSION: 11\.4\.2/u);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256/u);
  assert.doesNotMatch(workflow, /winget|choco|node-version:\s*['"]?latest|download\/latest/iu);
});

test("Windows installer CI uses explicit builders and conditional transport", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /npm run standard:runtime -- --core-tgz/u);
  assert.match(workflow, /--node-runtime/u);
  assert.match(workflow, /build-standard-windows-installer\.mjs --runtime-dir/u);
  assert.match(workflow, /verify-standard-installer-reproducibility\.mjs/u);
  assert.match(workflow, /installer-a/u);
  assert.match(workflow, /installer-b/u);
  assert.match(workflow, /release-transport-cli\.mjs verify-core/u);
  assert.match(workflow, /\$mode = if \(\$env:CORE_ARTIFACT_NAME/u);
  assert.match(workflow, /release-transport-cli\.mjs create-standard/u);
  assert.match(workflow, /retention-days: 1/u);
  assert.match(workflow, /if: inputs\.core-artifact-name != ''[\s\S]*actions\/upload-artifact/iu);
});

test("Windows installer CI uses engineering overrides or official defaults without client mutation", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /PCW_STANDARD_ROOT/u);
  assert.match(workflow, /Synthetic Standard Context/u);
  assert.match(workflow, /if \(\$buildA\.prototype\)/u);
  assert.match(workflow, /else \{\s*\$contextRoot = Join-Path \$env:USERPROFILE 'PCW\\My-PCW-Context'/u);
  const prototypeBranch = workflow.slice(
    workflow.indexOf("if ($buildA.prototype)"),
    workflow.indexOf("} else {", workflow.indexOf("if ($buildA.prototype)"))
  );
  assert.match(prototypeBranch, /PCWContext=/u);
  assert.match(prototypeBranch, /PCWStateRoot=/u);
  assert.match(prototypeBranch, /PCWHomeDirectory=/u);
  assert.match(workflow, /pcw-doctor\.cmd/u);
  assert.match(workflow, /verify-installed-standard-lifecycle\.mjs/u);
  assert.match(workflow, /STANDARD-INSTALLER-CI\.md/u);
  assert.match(workflow, /unins000\.exe/u);
  assert.match(workflow, /Uninstall removed the PCW context/u);
  assert.doesNotMatch(workflow, /PCWRemoveOwned=yes/u);
  assert.doesNotMatch(workflow, /--client cursor|--client codex|--client claude-desktop/u);
});

test("release-mode Windows path consumes transported Core and contains no source repack", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const transportedBranch = workflow.slice(
    workflow.indexOf("if ($env:CORE_ARTIFACT_NAME)"),
    workflow.indexOf("} else {")
  );
  assert.match(transportedBranch, /verify-core/u);
  assert.doesNotMatch(transportedBranch, /npm pack|packCoreTarball/iu);
});
