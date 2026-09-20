import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import YAML from "yaml";

const workflow = YAML.parse(await readFile(".github/workflows/release-build.yml", "utf8"), {
  uniqueKeys: true
});

test("release workflow runs development verification on distribution pushes and permits future manual dispatch", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"].sort());
  assert.deepEqual(workflow.on.push.branches, ["v0.3-distribution"]);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs["access-check"], undefined);
  assert.equal(workflow.on.pull_request, undefined);
});

test("release workflow validates Node 22 and 24 before one pinned packaging job", () => {
  assert.deepEqual(workflow.jobs.validate.strategy.matrix["node-version"], ["22.x", "24.x"]);
  assert.equal(workflow.jobs.package.needs, "validate");
  const steps = workflow.jobs.package.steps;
  assert.equal(steps.find((step) => step.uses === "actions/setup-node@v4")
    .with["node-version"], "24.3.0");
  assert.match(steps.find((step) => step.name === "Assert canonical packaging toolchain").run,
    /11\.4\.2/);
  assert.equal(steps.filter((step) => step.run?.includes("npm run release:build")).length, 2);
  assert.equal(steps.filter((step) => step.run?.includes("verify-release-set.mjs")).length, 2);
  const compare = steps.find((step) => step.name === "Verify B and compare every file with A");
  assert.match(compare.run, /--metadata-directory artifacts\/release-ci-verification/);
  const upload = steps.at(-1);
  assert.equal(upload.uses, "actions/upload-artifact@v4");
  assert.equal(upload.with["retention-days"], 7);
  assert.deepEqual(upload.with.path.trim().split("\n").map((path) => path.trim()), [
    "artifacts/release-ci-verification/release-manifest.json",
    "artifacts/release-ci-verification/SHA256SUMS.txt",
    "artifacts/release-ci-verification/verification-report.json"
  ]);
  assert.doesNotMatch(upload.with.path, /\.tgz|\.zip|artifacts\/releases/);
});
