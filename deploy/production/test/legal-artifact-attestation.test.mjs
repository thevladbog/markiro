import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createFreshPdfAValidator,
  verifyPublishedLegalArtifacts,
} from "../verify-legal-artifacts.mjs";

const root = new URL("../../../", import.meta.url);
const releasedRoot = new URL("apps/landing/public/legal/", root);
const releasedAttestation = new URL("deploy/production/legal-artifacts-attestation.json", root);
const releaseId = "MKR-LEGAL-2026.08-07-2026-08-30";
const manifestSha256 = "2efd70c19863a4521d2a12755e6a64111549955674c9f95fee0bddbaa6c54d61";
const releasedPdfNames = [
  "markiro_mkr-brd-01_2026.08-01_en.pdf",
  "markiro_mkr-brd-01_2026.08-01_ru.pdf",
  "markiro_mkr-dpa-01_2026.08-01_en.pdf",
  "markiro_mkr-dpa-01_2026.08-01_ru.pdf",
  "markiro_mkr-ins-01_2026.08-01_ru.pdf",
  "markiro_mkr-ins-02_2026.08-01_ru.pdf",
  "markiro_mkr-ins-03_2026.08-01_ru.pdf",
  "markiro_mkr-ins-04_2026.08-01_ru.pdf",
  "markiro_mkr-ins-05_2026.08-01_ru.pdf",
  "markiro_mkr-ins-06_2026.08-01_ru.pdf",
  "markiro_mkr-ins-07_2026.08-01_ru.pdf",
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

function pdfaValidatorSpy() {
  const calls = [];
  return {
    calls,
    validate: async (pdfPath) => {
      calls.push(pdfPath);
    },
  };
}

test("committed attestation independently binds the exact released PDF set", async (context) => {
  const work = await fixture();
  context.after(() => rm(work.directory, { recursive: true, force: true }));
  const spy = verifierSpy();
  const pdfaSpy = pdfaValidatorSpy();

  await verifyPublishedLegalArtifacts(
    work.artifactRoot,
    work.attestationPath,
    spy.verify,
    pdfaSpy.validate,
  );

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
  assert.equal(pdfaSpy.calls.length, 15);
  assert.deepEqual(
    pdfaSpy.calls.map((pdfPath) => path.basename(pdfPath)),
    releasedPdfNames.map((_fileName, index) => `document-${index}.pdf`),
  );
  assert.equal(spy.calls[0].pdfaValidatedFiles.size, 15);
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

test("coordinated PDF, manifest, and attestation tampering cannot self-attest", async (context) => {
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

  const attestation = await readJson(work.attestationPath);
  attestation.manifestSha256 = createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex");
  attestation.pdfs.find((entry) => entry.fileName === pdf.fileName).sha256 = pdf.sha256;
  await writeJson(work.attestationPath, attestation);

  let validationCalls = 0;
  await assert.rejects(
    verifyPublishedLegalArtifacts(
      work.artifactRoot,
      work.attestationPath,
      verifierSpy().verify,
      async (pdfPath) => {
        validationCalls += 1;
        assert.equal(
          (await readFile(pdfPath)).includes(Buffer.from("not PDF/A")),
          true,
          "the validator must receive the privately copied tampered PDF bytes",
        );
        throw new Error("synthetic non-conformant PDF/A result");
      },
    ),
    { message: "synthetic non-conformant PDF/A result" },
  );
  assert.equal(validationCalls, 1);
});

test("fresh veraPDF commands are time-bounded and retain their private failure cause", async (context) => {
  const previousBinary = process.env.VERAPDF_BIN;
  const previousRuntime = process.env.VERAPDF_CONTAINER_RUNTIME;
  process.env.VERAPDF_BIN = "/opt/verapdf/verapdf";
  delete process.env.VERAPDF_CONTAINER_RUNTIME;
  context.after(() => {
    if (previousBinary === undefined) delete process.env.VERAPDF_BIN;
    else process.env.VERAPDF_BIN = previousBinary;
    if (previousRuntime === undefined) delete process.env.VERAPDF_CONTAINER_RUNTIME;
    else process.env.VERAPDF_CONTAINER_RUNTIME = previousRuntime;
  });

  const privateCause = new Error("private validator process detail");
  const calls = [];
  const validate = createFreshPdfAValidator({
    execute: async (binary, args, options) => {
      calls.push({ binary, args, options });
      if (args[0] === "--version") return { stdout: "veraPDF 1.30.2\n", stderr: "" };
      throw privateCause;
    },
    parseVeraPdfValidationResult: () => undefined,
    image: "unused-with-direct-binary",
    version: "1.30.2",
  });

  await assert.rejects(validate("/private/document.pdf"), (error) => {
    assert.equal(error.message, "fresh pinned veraPDF validation failed");
    assert.equal(error.cause, privateCause);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ options }) => options.timeout),
    [60_000, 60_000],
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
