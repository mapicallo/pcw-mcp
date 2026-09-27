import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyStandardInstallerReproducibility } from "../scripts/verify-standard-installer-reproducibility.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pcw-installer-repro-"));
  try {
    const installerA = join(root, "a.exe");
    const installerB = join(root, "b.exe");
    const reportA = join(root, "a.json");
    const reportB = join(root, "b.json");
    const bytes = Buffer.from("synthetic installer");
    const make = (installer, installerBytes) => ({
      ok: true,
      installer,
      prototype: true,
      softwareVersion: "0.3.0-beta.2-dev.0",
      coreTgzSha256: sha256("canonical Core"),
      inputFingerprint: sha256("same inputs"),
      installerSha256: sha256(installerBytes)
    });
    await writeFile(installerA, bytes);
    await writeFile(installerB, bytes);
    await writeFile(reportA, JSON.stringify(make(installerA, bytes)));
    await writeFile(reportB, JSON.stringify(make(installerB, bytes)));
    await run({ installerA, installerB, reportA, reportB, bytes, make });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("reproducibility gate accepts identical pre-Inno fingerprints and EXE bytes", () =>
  fixture(async ({ reportA, reportB, bytes }) => {
    const result = await verifyStandardInstallerReproducibility(reportA, reportB);
    assert.equal(result.deterministicBuildsMatch, true);
    assert.equal(result.installerSha256, sha256(bytes));
    assert.equal(result.coreTgzSha256, sha256("canonical Core"));
    assert.equal(result.sizeBytes, bytes.length);
  }));

test("reproducibility gate fails closed for input or EXE drift", () =>
  fixture(async ({ installerB, reportA, reportB, bytes, make }) => {
    const changedInput = make(installerB, bytes);
    changedInput.inputFingerprint = sha256("different inputs");
    await writeFile(reportB, JSON.stringify(changedInput));
    await assert.rejects(
      verifyStandardInstallerReproducibility(reportA, reportB),
      /input fingerprints differ/
    );
    const changedBytes = Buffer.from("different installer");
    await writeFile(installerB, changedBytes);
    await writeFile(reportB, JSON.stringify(make(installerB, changedBytes)));
    await assert.rejects(
      verifyStandardInstallerReproducibility(reportA, reportB),
      /not byte-identical/
    );
  }));
