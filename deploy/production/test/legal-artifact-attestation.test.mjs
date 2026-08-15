import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyPublishedLegalArtifacts } from "../verify-legal-artifacts.mjs";

const root = new URL("../../../", import.meta.url);
const releasedRoot = new URL("apps/landing/public/legal/", root);
const releasedAttestation = new URL("deploy/production/legal-artifacts-attestation.json", root);
const releaseId = "MKR-LEGAL-2026.08-01-2026-08-15";
const manifestSha256 = "5e7550ed78ce08d35211353fee4e45378cdc88a46f70441b1a98e333ca3cbbae";
const releasedPdfNames = [
  "markiro_mkr-brd-01_2026.08-01_en.pdf",
  "markiro_mkr-brd-01_2026.08-01_ru.pdf",
  "markiro_mkr-dpa-01_2026.08-01_en.pdf",
  "markiro_mkr-dpa-01_2026.08-01_ru.pdf",
  "markiro_mkr-pd-01_2026.08-01_en.pdf",
  "markiro_mkr-pd-01_2026.08-01_ru.pdf",
  "markiro_mkr-pd-02_2026.08-01_en.pdf",
  "markiro_mkr-pd-02_2026.08-01_ru.pdf",
];
const oldPdfNames = releasedPdfNames.map((fileName) =>
  fileName.replace("2026.08-01", "2026.08.01"),
);

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "markiro-legal-attestation-"));
  const artifactRoot = path.join(directory, "legal");
  const attestationPath = path.join(directory, "attestation.json");
  await cp(releasedRoot, artifactRoot, { recursive: true });
  await cp(releasedAttestation, attestationPath);
  return { directory, artifactRoot, attestationPath };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function verifierSpy() {
  const calls = [];
  return {
    calls,
    verify: async (options) => {
      calls.push(options);
      return [];
    },
  };
}

test("committed attestation independently binds the exact released PDF set", async (context) => {
  const work = await fixture();
  context.after(() => rm(work.directory, { recursive: true, force: true }));
  const spy = verifierSpy();

  await verifyPublishedLegalArtifacts(work.artifactRoot, work.attestationPath, spy.verify);

  const attestation = await readJson(work.attestationPath);
  const manifestBytes = await readFile(path.join(work.artifactRoot, "artifacts.json"));
  assert.equal(attestation.releaseId, releaseId);
  assert.equal(attestation.manifestSha256, manifestSha256);
  assert.equal(
    attestation.manifestSha256,
    createHash("sha256").update(manifestBytes).digest("hex"),
  );
  assert.deepEqual(
    attestation.pdfs.map(({ fileName }) => fileName),
    releasedPdfNames,
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].pdfaValidatedFiles.size, 8);
  assert.deepEqual(
    [...spy.calls[0].pdfaValidatedFiles].sort(),
    (await readJson(work.attestationPath)).pdfs.map(({ fileName }) => fileName).sort(),
  );
});

for (const [index, oldFileName] of oldPdfNames.entries()) {
  test(`rejects legacy trusted filename ${oldFileName}`, async (context) => {
    const work = await fixture();
    context.after(() => rm(work.directory, { recursive: true, force: true }));
    const attestation = await readJson(work.attestationPath);
    attestation.pdfs[index].fileName = oldFileName;
    await writeJson(work.attestationPath, attestation);

    await assert.rejects(
      verifyPublishedLegalArtifacts(work.artifactRoot, work.attestationPath, verifierSpy().verify),
      /attestation|attested PDF|manifest SHA-256/i,
    );
  });
}

test("self-consistent manifest and PDF tampering cannot rewrite release evidence", async (context) => {
  const work = await fixture();
  context.after(() => rm(work.directory, { recursive: true, force: true }));
  const manifestPath = path.join(work.artifactRoot, "artifacts.json");
  const manifest = await readJson(manifestPath);
  const pdf = manifest.find((entry) => entry.kind === "pdfa-2b");
  const tampered = Buffer.from("%PDF-1.7\nnot PDF/A\n%%EOF\n");
  await writeFile(path.join(work.artifactRoot, "files", pdf.fileName), tampered);
  pdf.bytes = tampered.byteLength;
  pdf.sha256 = createHash("sha256").update(tampered).digest("hex");
  await writeJson(manifestPath, manifest);

  await assert.rejects(
    verifyPublishedLegalArtifacts(work.artifactRoot, work.attestationPath, verifierSpy().verify),
    /manifest SHA-256 does not match the trusted attestation/,
  );
});

for (const mutation of ["extra", "missing", "duplicate", "wrong hash", "unsafe path"]) {
  test(`rejects ${mutation} trusted attestation drift`, async (context) => {
    const work = await fixture();
    context.after(() => rm(work.directory, { recursive: true, force: true }));
    const attestation = await readJson(work.attestationPath);
    if (mutation === "extra")
      attestation.pdfs.push({ fileName: "markiro_extra.pdf", sha256: "a".repeat(64) });
    if (mutation === "missing") attestation.pdfs.pop();
    if (mutation === "duplicate") attestation.pdfs.push(attestation.pdfs[0]);
    if (mutation === "wrong hash") attestation.pdfs[0].sha256 = "a".repeat(64);
    if (mutation === "unsafe path") attestation.pdfs[0].fileName = "../escaped.pdf";
    await writeJson(work.attestationPath, attestation);

    await assert.rejects(
      verifyPublishedLegalArtifacts(work.artifactRoot, work.attestationPath, verifierSpy().verify),
      /attestation|attested PDF|manifest SHA-256/i,
    );
  });
}

test("rejects a symlinked trusted attestation", async (context) => {
  const work = await fixture();
  context.after(() => rm(work.directory, { recursive: true, force: true }));
  const target = `${work.attestationPath}.target`;
  await cp(work.attestationPath, target);
  await rm(work.attestationPath);
  await symlink(target, work.attestationPath);
  assert.equal((await lstat(work.attestationPath)).isSymbolicLink(), true);

  await assert.rejects(
    verifyPublishedLegalArtifacts(work.artifactRoot, work.attestationPath, verifierSpy().verify),
    /attestation must be an ordinary file/,
  );
});
