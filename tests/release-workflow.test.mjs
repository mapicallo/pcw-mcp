import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import YAML from "yaml";

const workflow = YAML.parse(await readFile(".github/workflows/release-build.yml", "utf8"), {
  uniqueKeys: true
});

test("release workflow retains read-only permissions and Node 22/24 validation", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"].sort());
  assert.deepEqual(workflow.on.push.branches, ["v0.3-distribution"]);
  assert.equal(workflow.on.workflow_dispatch.inputs["release-grade"].default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs["released-at"].default, "");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.validate.strategy.matrix["node-version"], ["22.x", "24.x"]);
});

test("one producer transports the canonical Core to reusable Windows packaging", () => {
  const core = workflow.jobs.core;
  assert.equal(core.needs, "validate");
  assert.match(core.steps.find((step) => step.name === "Produce canonical Core once").run,
    /release-transport-cli\.mjs create-core/u);
  const upload = core.steps.find((step) => step.name === "Transport canonical Core bytes to Windows");
  assert.equal(upload.uses, "actions/upload-artifact@v4");
  assert.equal(upload.with["retention-days"], 1);
  assert.equal(upload.with.path, "artifacts/core-transport");
  const windows = workflow.jobs["standard-windows"];
  assert.equal(windows.uses, "./.github/workflows/standard-windows.yml");
  assert.equal(windows.with["core-artifact-name"], "${{ needs.core.outputs.artifact-name }}");
  assert.equal(windows.with["expected-source-commit"], "${{ github.sha }}");
});

test("finalization verifies exact returned bytes and never rebuilds the installer", () => {
  const finalize = workflow.jobs.finalize;
  assert.deepEqual(finalize.needs, ["core", "standard-windows"]);
  const steps = finalize.steps;
  assert.equal(steps.filter((step) => step.uses === "actions/download-artifact@v4").length, 2);
  assert.match(steps.find((step) => step.name === "Verify cross-job Core and Standard provenance").run,
    /release-transport-cli\.mjs verify-standard/u);
  assert.equal(steps.filter((step) => step.run?.includes("npm run release:build")).length, 4);
  assert.equal(steps.filter((step) => step.run?.includes("verify-release-set.mjs")).length, 2);
  assert.equal(steps.some((step) => /build-standard-windows-installer|ISCC/iu.test(step.run ?? "")), false);
  const official = steps.filter((step) => step.if === "inputs.release-grade == true");
  assert.equal(official.length, 2);
  for (const step of official) {
    assert.match(step.run, /--standard-windows-installer artifacts\/downloaded-standard/u);
    assert.match(step.run, /--standard-windows-verification artifacts\/downloaded-standard/u);
    assert.match(step.run, /--release --released-at/u);
  }
  const retained = steps.at(-1);
  assert.equal(retained.uses, "actions/upload-artifact@v4");
  assert.equal(retained.with["retention-days"], 7);
  assert.deepEqual(retained.with.path.trim().split("\n").map((path) => path.trim()), [
    "artifacts/release-ci-verification/release-manifest.json",
    "artifacts/release-ci-verification/SHA256SUMS.txt",
    "artifacts/release-ci-verification/verification-report.json"
  ]);
  assert.doesNotMatch(retained.with.path, /\.tgz|\.zip|\.exe|artifacts\/releases/u);
});
