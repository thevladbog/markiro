import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertDepositablePath,
  buildDeposit,
  parseArguments,
  validateManifest,
} from "../build-deposit.mjs";

const baseManifest = {
  title: "Маркиро",
  holder: "Богатырев Владислав Сергеевич",
  authors: ["Богатырев Владислав Сергеевич"],
  version: "test",
  languages: ["TypeScript"],
  maxPages: 10,
  files: [{ path: "packages/domain/src/gs1/check-digit.ts", comment: "контрольная цифра" }],
};

test("parseArguments accepts the documented flags only", () => {
  assert.deepEqual(parseArguments([]), {
    manifest: "docs/registration/rospatent/deposit-manifest.json",
    out: "docs/registration/rospatent/build",
    date: null,
  });
  assert.equal(parseArguments(["--date", "2026-09-10T00:00:00Z"]).date, "2026-09-10T00:00:00Z");
  assert.throws(() => parseArguments(["--date", "yesterday"]), /ISO 8601/u);
  assert.throws(() => parseArguments(["--bogus"]), /Unknown/u);
});

test("assertDepositablePath refuses vendored, generated and secret-bearing files", () => {
  assertDepositablePath("apps/api/src/main.ts");
  assert.throws(() => assertDepositablePath("/etc/passwd"), /inside the repository/u);
  assert.throws(() => assertDepositablePath("../other/file.ts"), /inside the repository/u);
  assert.throws(() => assertDepositablePath("apps/api/node_modules/x/index.ts"), /vendored/u);
  assert.throws(() => assertDepositablePath("apps/api/dist/main.ts"), /vendored/u);
  assert.throws(() => assertDepositablePath(".env"), /secret/u);
  assert.throws(() => assertDepositablePath("deploy/production/ca.pem"), /secret/u);
  assert.throws(() => assertDepositablePath("README.md"), /unsupported/u);
});

test("validateManifest rejects incomplete manifests and duplicates", () => {
  assert.equal(validateManifest(baseManifest), baseManifest);
  assert.throws(() => validateManifest({ ...baseManifest, title: " " }), /title/u);
  assert.throws(() => validateManifest({ ...baseManifest, authors: [] }), /authors/u);
  assert.throws(() => validateManifest({ ...baseManifest, maxPages: 0 }), /maxPages/u);
  assert.throws(() => validateManifest({ ...baseManifest, abstract: "/etc/x.md" }), /inside/u);
  assert.throws(() => validateManifest({ ...baseManifest, abstract: "docs/a.txt" }), /Markdown/u);
  assert.throws(
    () =>
      validateManifest({ ...baseManifest, files: [...baseManifest.files, ...baseManifest.files] }),
    /duplicate/u,
  );
});

test("buildDeposit writes the PDF and a summary, and enforces maxPages", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "rospatent-"));
  try {
    const manifestPath = path.join(workspace, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(baseManifest));
    const out = path.join(workspace, "out");
    const { summary, pdfPath } = await buildDeposit({
      manifest: manifestPath,
      out,
      date: "2026-09-10T00:00:00Z",
    });
    assert.equal(summary.pages, 3);
    assert.equal(summary.files[0].firstPage, 3);
    assert.deepEqual(summary.files[0].lines, [1, summary.files[0].totalLines]);
    assert.match(summary.files[0].sha256, /^[0-9a-f]{64}$/u);
    const bytes = await readFile(pdfPath);
    assert.ok(bytes.subarray(0, 8).toString("latin1").startsWith("%PDF-1.5"));
    assert.equal(summary.pdf.bytes, bytes.length);
    const written = JSON.parse(await readFile(path.join(out, "deposit-summary.json"), "utf8"));
    assert.equal(written.pdf.sha256, summary.pdf.sha256);
    assert.equal(written.generatedAt, "2026-09-10T00:00:00.000Z");
    const abstract = await readFile(path.join(out, "abstract.pdf"));
    assert.ok(abstract.subarray(0, 8).toString("latin1").startsWith("%PDF-1.5"));
    assert.equal(summary.abstract.bytes, abstract.length);
    assert.equal(summary.abstract.edition, "Основная редакция");
    assert.ok(summary.abstract.characters > 500);

    await writeFile(manifestPath, JSON.stringify({ ...baseManifest, maxPages: 2 }));
    await assert.rejects(
      buildDeposit({ manifest: manifestPath, out, date: null }),
      /above manifest\.maxPages/u,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
