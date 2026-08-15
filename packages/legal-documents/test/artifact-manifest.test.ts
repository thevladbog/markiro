import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { zlibSync } from "fflate";

import {
  MAX_LEGAL_PDF_BYTES,
  canonicalArtifactManifest,
  parseVerificationArguments,
  verifyArtifactManifest,
  type PublishedLegalArtifact,
} from "../src/cli/verify-artifacts.js";
import {
  LIBREOFFICE_PDF_EXPORT_FILTER,
  acquireArtifactGenerationLock,
  artifactGenerationLockPath,
  assertEmbeddedPdfFonts,
  assertExtractedPdfText,
  assertNoFontSubstitutionWarnings,
  assertReleaseLibreOfficeVersion,
  generateLegalArtifacts,
  libreOfficeEnvironment,
  libreOfficeProfileDirectory,
  libreOfficePdfExportArguments,
  normalizeLibreOfficePdf,
  parsePdfPageCount,
  parseVeraPdfValidationResult,
  resolveGenerationOutput,
  type ArtifactGenerationDependencies,
} from "../src/cli/generate-artifacts.js";

const temporaryRoots: string[] = [];
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

interface VeraPdfFixture {
  report: {
    jobs: {
      validationResult: {
        compliant: boolean;
        jobEndStatus: string;
        profileName: string;
        details: { failedRules: number; failedChecks: number };
      }[];
    }[];
    batchSummary: {
      totalJobs: number;
      outOfMemory: number;
      veraExceptions: number;
      featuresSummary: {
        failedJobCount: number;
        totalJobCount: number;
        successfulJobCount: number;
      };
      repairSummary: {
        failedJobCount: number;
        totalJobCount: number;
        successfulJobCount: number;
      };
      multiJob: boolean;
      failedEncryptedJobs: number;
      failedParsingJobs: number;
      validationSummary: {
        totalJobCount: number;
        successfulJobCount: number;
        failedJobCount: number;
        compliantPdfaCount: number;
        nonCompliantPdfaCount: number;
      };
    };
  };
}

function compliantVeraPdfFixture(): VeraPdfFixture {
  return {
    report: {
      jobs: [
        {
          validationResult: [
            {
              compliant: true,
              jobEndStatus: "normal",
              profileName: "PDF/A-2b validation profile",
              details: { failedRules: 0, failedChecks: 0 },
            },
          ],
        },
      ],
      batchSummary: {
        totalJobs: 1,
        outOfMemory: 0,
        veraExceptions: 0,
        featuresSummary: { failedJobCount: 0, totalJobCount: 0, successfulJobCount: 0 },
        repairSummary: { failedJobCount: 0, totalJobCount: 0, successfulJobCount: 0 },
        multiJob: false,
        failedEncryptedJobs: 0,
        failedParsingJobs: 0,
        validationSummary: {
          totalJobCount: 1,
          successfulJobCount: 1,
          failedJobCount: 0,
          compliantPdfaCount: 1,
          nonCompliantPdfaCount: 0,
        },
      },
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "markiro-legal-artifacts-test-"));
  temporaryRoots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactBytes(fileName: string): Uint8Array {
  return Buffer.from(
    fileName.endsWith(".pdf")
      ? `%PDF-1.7\nfixture:${fileName}\n%%EOF\n`
      : `PK fixture:${fileName}\n`,
  );
}

function pdfWithIccTimestamp(
  xmpTime: string,
  pdfTime: string,
  id: string,
  iccTime: readonly [number, number, number, number, number, number],
  swapFontGroups = false,
  includeProtectedReferences = false,
): Buffer {
  const profile = Buffer.alloc(128);
  profile.writeUInt32BE(profile.byteLength, 0);
  profile.write("lcms", 4, "ascii");
  profile.write("mntrRGB XYZ ", 12, "ascii");
  iccTime.forEach((value, index) => profile.writeUInt16BE(value, 24 + index * 2));
  profile.write("acsp", 36, "ascii");
  const compressedProfile = Buffer.from(zlibSync(profile, { level: 9 }));
  const fontGroup = (
    start: number,
    baseFont: string,
    payload: string,
  ): readonly { readonly number: number; readonly bytes: Buffer }[] => {
    const fontBytes = Buffer.from(zlibSync(Buffer.from(payload), { level: 9 }));
    const unicodeBytes = Buffer.from(zlibSync(Buffer.from(`unicode:${baseFont}`), { level: 9 }));
    return [
      {
        number: start,
        bytes: Buffer.concat([
          Buffer.from(
            `${start} 0 obj\n<</Length ${start + 1} 0 R/Filter/FlateDecode/Length1 ${payload.length}>>\nstream\n`,
          ),
          fontBytes,
          Buffer.from("\nendstream\nendobj\n"),
        ]),
      },
      {
        number: start + 1,
        bytes: Buffer.from(`${start + 1} 0 obj\n${fontBytes.length}\nendobj\n`),
      },
      {
        number: start + 2,
        bytes: Buffer.from(
          `${start + 2} 0 obj\n<</Type/FontDescriptor/FontName/${baseFont}/FontFile2 ${start} 0 R>>\nendobj\n`,
        ),
      },
      {
        number: start + 3,
        bytes: Buffer.concat([
          Buffer.from(
            `${start + 3} 0 obj\n<</Length ${unicodeBytes.length}/Filter/FlateDecode>>\nstream\n`,
          ),
          unicodeBytes,
          Buffer.from("\nendstream\nendobj\n"),
        ]),
      },
      {
        number: start + 4,
        bytes: Buffer.from(
          `${start + 4} 0 obj\n<</Type/Font/Subtype/TrueType/BaseFont/${baseFont}/FontDescriptor ${start + 2} 0 R/ToUnicode ${start + 3} 0 R>>\nendobj\n`,
        ),
      },
    ];
  };
  const monoName = "BAAAAA+IBMPlexMono-Bold";
  const sansName = "DAAAAA+IBMPlexSans-Bold";
  const firstFontName = swapFontGroups ? sansName : monoName;
  const secondFontName = swapFontGroups ? monoName : sansName;
  const monoRoot = swapFontGroups ? 16 : 11;
  const sansRoot = swapFontGroups ? 11 : 16;
  const objects: readonly { readonly number: number; readonly bytes: Buffer }[] = [
    {
      number: 1,
      bytes: Buffer.from(
        [
          "1 0 obj",
          `<</Type/Catalog/OutputIntents[2 0 R]/Fonts[${monoRoot} 0 R ${sansRoot} 0 R]`,
          ...(includeProtectedReferences
            ? [
                "/Literal(keep 7 0 R nested (8 0 R) escaped \\(9 0 R\\))",
                "/Hex<313020302052>",
                "/7 0 R",
                "/7#20escaped 0 R",
                "% keep 11 0 R",
              ]
            : []),
          ">>",
          "endobj",
          "",
        ].join("\n"),
      ),
    },
    {
      number: 2,
      bytes: Buffer.from("2 0 obj\n<</Type/OutputIntent/DestOutputProfile 3 0 R>>\nendobj\n"),
    },
    {
      number: 3,
      bytes: Buffer.concat([
        Buffer.from("3 0 obj\n<</N 3/Length 4 0 R/Filter/FlateDecode>>\nstream\n"),
        compressedProfile,
        Buffer.from("\nendstream\nendobj\n"),
      ]),
    },
    { number: 4, bytes: Buffer.from(`4 0 obj\n${compressedProfile.byteLength}\nendobj\n`) },
    {
      number: 5,
      bytes: Buffer.from(
        [
          "5 0 obj",
          `<xmp:CreateDate>${xmpTime}</xmp:CreateDate>`,
          `<xmp:ModifyDate>${xmpTime}</xmp:ModifyDate>`,
          `<xmp:MetadataDate>${xmpTime}</xmp:MetadataDate>`,
          `<dc:date><rdf:Seq><rdf:li>${xmpTime}</rdf:li></rdf:Seq></dc:date>`,
          "endobj",
          "",
        ].join("\n"),
      ),
    },
    { number: 6, bytes: Buffer.from(`6 0 obj\n<</CreationDate(D:${pdfTime})>>\nendobj\n`) },
    ...fontGroup(7, firstFontName, `font:${firstFontName}`),
    ...fontGroup(12, secondFontName, `font:${secondFontName}`),
  ];
  const header = Buffer.from("%PDF-1.7\n");
  const offsets = new Array<number>(17).fill(0);
  let offset = header.byteLength;
  for (const object of objects) {
    offsets[object.number] = offset;
    offset += object.bytes.byteLength;
  }
  const xrefOffset = offset;
  const xref = [
    "xref",
    "0 17",
    "0000000000 65535 f ",
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `),
    "trailer",
    `<</Size 17/Root 1 0 R/Info 6 0 R/ID [ <${id}> <${id}> ]>>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  return Buffer.concat([header, ...objects.map(({ bytes }) => bytes), Buffer.from(xref)]);
}

function artifactEntry(
  code: PublishedLegalArtifact["code"],
  locale: PublishedLegalArtifact["locale"],
  kind: PublishedLegalArtifact["kind"],
): { readonly entry: PublishedLegalArtifact; readonly bytes: Uint8Array } {
  const extension = kind === "pdfa-2b" ? "pdf" : "docx";
  const fileName = `markiro_${code.toLowerCase()}_2026.08.01_${locale}.${extension}`;
  const bytes = artifactBytes(fileName);
  return {
    bytes,
    entry: {
      code,
      revision: "2026.08.01",
      effectiveDate: "2026-08-15",
      locale,
      kind,
      fileName,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      mediaType: kind === "pdfa-2b" ? "application/pdf" : DOCX_MEDIA_TYPE,
      generator:
        kind === "pdfa-2b"
          ? { docx: "9.7.1", libreOffice: "26.2.5", veraPdf: "1.30.2" }
          : { docx: "9.7.1" },
    },
  };
}

function validArtifacts(): {
  readonly entries: PublishedLegalArtifact[];
  readonly bytesByFile: ReadonlyMap<string, Uint8Array>;
  readonly pdfaValidatedFiles: ReadonlySet<string>;
} {
  const artifacts = (["MKR-PD-01", "MKR-PD-02", "MKR-DPA-01", "MKR-BRD-01"] as const).flatMap(
    (code) =>
      (["ru", "en"] as const).flatMap((locale) => [
        artifactEntry(code, locale, "pdfa-2b"),
        ...(code === "MKR-DPA-01" || code === "MKR-BRD-01"
          ? [artifactEntry(code, locale, "template-docx")]
          : []),
      ]),
  );
  return {
    entries: artifacts.map(({ entry }) => entry),
    bytesByFile: new Map(artifacts.map(({ entry, bytes }) => [entry.fileName, bytes])),
    pdfaValidatedFiles: new Set(
      artifacts.filter(({ entry }) => entry.kind === "pdfa-2b").map(({ entry }) => entry.fileName),
    ),
  };
}

async function writeManifest(
  manifestPath: string,
  entries: readonly PublishedLegalArtifact[],
): Promise<void> {
  const sorted = [...entries].sort((left, right) => left.fileName.localeCompare(right.fileName));
  await writeFile(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
}

async function validFixture(): Promise<{
  readonly rootDir: string;
  readonly filesDir: string;
  readonly manifestPath: string;
  readonly entries: PublishedLegalArtifact[];
  readonly pdfaValidatedFiles: ReadonlySet<string>;
}> {
  const rootDir = await temporaryRoot();
  const filesDir = path.join(rootDir, "files");
  const manifestPath = path.join(rootDir, "artifacts.json");
  const { entries, bytesByFile, pdfaValidatedFiles } = validArtifacts();
  await mkdir(filesDir);
  await Promise.all(
    [...bytesByFile].map(async ([fileName, bytes]) =>
      writeFile(path.join(filesDir, fileName), bytes),
    ),
  );
  await writeManifest(manifestPath, entries);
  return { rootDir, filesDir, manifestPath, entries, pdfaValidatedFiles };
}

async function rewriteFixtureManifest(
  fixture: Awaited<ReturnType<typeof validFixture>>,
  entries: readonly PublishedLegalArtifact[],
): Promise<void> {
  await writeManifest(fixture.manifestPath, entries);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })));
});

describe("published legal artifact manifest verification", () => {
  it("requires one explicit artifact root from the verifier CLI", () => {
    expect(parseVerificationArguments(["--out-dir", "/tmp/legal"])).toEqual({
      outDir: "/tmp/legal",
    });
    expect(() => parseVerificationArguments([])).toThrow("explicit --out-dir");
    expect(() =>
      parseVerificationArguments(["--out-dir", "/tmp/one", "--out-dir", "/tmp/two"]),
    ).toThrow("only once");
  });

  it("accepts the complete current release with independently validated PDFs", async () => {
    const fixture = await validFixture();

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).resolves.toEqual(
      [...fixture.entries].sort((left, right) => left.fileName.localeCompare(right.fileName)),
    );
  });

  it("rejects a pre-commit publication root until its manifest marker appears", async () => {
    const rootDir = await temporaryRoot();
    await mkdir(path.join(rootDir, "files"));

    await expect(
      verifyArtifactManifest({
        rootDir,
        manifestPath: path.join(rootDir, "artifacts.json"),
        pdfaValidatedFiles: new Set(),
      }),
    ).rejects.toThrow("artifact root entry");
  });

  it("rejects a manifest entry whose file is missing", async () => {
    const fixture = await validFixture();
    const missing = fixture.entries[0];
    if (!missing) throw new Error("Fixture has no artifacts");
    await unlink(path.join(fixture.filesDir, missing.fileName));

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("missing");
  });

  it("rejects an extra file that is absent from the manifest", async () => {
    const fixture = await validFixture();
    await writeFile(path.join(fixture.filesDir, "unlisted.pdf"), "%PDF-1.7\n%%EOF\n");

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("extra");
  });

  it("rejects any build-tool state outside files and artifacts.json", async () => {
    const fixture = await validFixture();
    await mkdir(path.join(fixture.rootDir, "libreoffice-home"));

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("artifact root entry");
  });

  it("rejects duplicate artifact descriptors", async () => {
    const fixture = await validFixture();
    const duplicate = fixture.entries[0];
    if (!duplicate) throw new Error("Fixture has no artifacts");
    await rewriteFixtureManifest(fixture, [...fixture.entries, duplicate]);

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("Duplicate");
  });

  it("rejects unsafe artifact names", async () => {
    const fixture = await validFixture();
    const first = fixture.entries[0];
    if (!first) throw new Error("Fixture has no artifacts");
    await rewriteFixtureManifest(fixture, [
      { ...first, fileName: "../outside.pdf" },
      ...fixture.entries.slice(1),
    ]);

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("Unsafe");
  });

  it("rejects symbolic links instead of following them", async () => {
    const fixture = await validFixture();
    const linked = fixture.entries[0];
    if (!linked) throw new Error("Fixture has no artifacts");
    const target = path.join(await temporaryRoot(), "outside.pdf");
    await writeFile(target, artifactBytes(linked.fileName));
    await unlink(path.join(fixture.filesDir, linked.fileName));
    await symlink(target, path.join(fixture.filesDir, linked.fileName));

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("symbolic link");
  });

  it.each([
    ["byte size", (entry: PublishedLegalArtifact) => ({ ...entry, bytes: entry.bytes + 1 })],
    ["SHA-256", (entry: PublishedLegalArtifact) => ({ ...entry, sha256: "0".repeat(64) })],
  ])("rejects a wrong %s", async (_case, mutate) => {
    const fixture = await validFixture();
    const first = fixture.entries[0];
    if (!first) throw new Error("Fixture has no artifacts");
    await rewriteFixtureManifest(fixture, [mutate(first), ...fixture.entries.slice(1)]);

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow(_case === "byte size" ? "size" : "SHA-256");
  });

  it("rejects an unlisted current release", async () => {
    const fixture = await validFixture();
    const omitted = fixture.entries[0];
    if (!omitted) throw new Error("Fixture has no artifacts");
    await unlink(path.join(fixture.filesDir, omitted.fileName));
    await rewriteFixtureManifest(fixture, fixture.entries.slice(1));

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("current release");
  });

  it.each(["MKR-PD-01", "MKR-PD-02"] as const)(
    "rejects a downloadable DOCX for %s",
    async (code) => {
      const fixture = await validFixture();
      const oldEntry = fixture.entries.find(
        (entry) =>
          entry.code === "MKR-DPA-01" && entry.locale === "ru" && entry.kind === "template-docx",
      );
      if (!oldEntry) throw new Error("Fixture has no DPA template");
      const invalid = artifactEntry(code, "ru", "template-docx");
      await unlink(path.join(fixture.filesDir, oldEntry.fileName));
      await writeFile(path.join(fixture.filesDir, invalid.entry.fileName), invalid.bytes);
      await rewriteFixtureManifest(
        fixture,
        fixture.entries.map((entry) => (entry === oldEntry ? invalid.entry : entry)),
      );

      await expect(
        verifyArtifactManifest({
          rootDir: fixture.rootDir,
          manifestPath: fixture.manifestPath,
          pdfaValidatedFiles: new Set([...fixture.pdfaValidatedFiles, invalid.entry.fileName]),
        }),
      ).rejects.toThrow("downloadable template");
    },
  );

  it("rejects a PDF descriptor without pinned PDF/A validation evidence", async () => {
    const fixture = await validFixture();
    const pdf = fixture.entries.find((entry) => entry.kind === "pdfa-2b");
    if (!pdf) throw new Error("Fixture has no PDF");
    await rewriteFixtureManifest(fixture, [
      { ...pdf, generator: { docx: "9.7.1", libreOffice: "26.2.5" } },
      ...fixture.entries.filter((entry) => entry !== pdf),
    ]);

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("PDF/A validation evidence");
  });

  it("rejects a PDF that was not validated in the current run", async () => {
    const fixture = await validFixture();
    const omitted = fixture.entries.find((entry) => entry.kind === "pdfa-2b");
    if (!omitted) throw new Error("Fixture has no PDF");
    const evidence = new Set(fixture.pdfaValidatedFiles);
    evidence.delete(omitted.fileName);

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: evidence,
      }),
    ).rejects.toThrow("not validated as PDF/A-2b");
  });

  it("rejects a manifest path outside the requested artifact root", async () => {
    const fixture = await validFixture();
    const outside = path.join(await temporaryRoot(), "artifacts.json");
    await writeFile(outside, await readFile(fixture.manifestPath));

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: outside,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("inside the artifact root");
  });

  it("rejects a PDF above the five MiB release bound", async () => {
    expect(MAX_LEGAL_PDF_BYTES).toBe(5 * 1024 * 1024);
    const fixture = await validFixture();
    const pdf = fixture.entries.find((entry) => entry.kind === "pdfa-2b");
    if (!pdf) throw new Error("Fixture has no PDF");
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20);
    await writeFile(path.join(fixture.filesDir, pdf.fileName), oversized);
    await rewriteFixtureManifest(fixture, [
      { ...pdf, bytes: oversized.byteLength, sha256: sha256(oversized) },
      ...fixture.entries.filter((entry) => entry !== pdf),
    ]);

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("five MiB");
  });

  it("requires canonical filename order, indentation, and a final newline", async () => {
    const fixture = await validFixture();
    await writeFile(fixture.manifestPath, JSON.stringify([...fixture.entries].reverse()));

    await expect(
      verifyArtifactManifest({
        rootDir: fixture.rootDir,
        manifestPath: fixture.manifestPath,
        pdfaValidatedFiles: fixture.pdfaValidatedFiles,
      }),
    ).rejects.toThrow("canonical");
    expect(canonicalArtifactManifest(fixture.entries).endsWith("\n")).toBe(true);
  });
});

function fakeGenerationDependencies(
  options: { readonly failValidationAt?: number } = {},
): ArtifactGenerationDependencies & { readonly converted: string[] } {
  const converted: string[] = [];
  let validations = 0;
  return {
    converted,
    getLibreOfficeVersion: async () => "LibreOffice 26.2.5.2 60(Build:2)",
    renderDocx: async (request) =>
      Buffer.from(`DOCX:${request.code}:${request.locale}:${request.kind}`),
    convertPdf: async ({ outputDirectory, sourcePath }) => {
      const stem = path.basename(sourcePath, ".docx");
      converted.push(stem);
      await writeFile(
        path.join(outputDirectory, `${stem}.pdf`),
        [
          "%PDF-1.7",
          stem,
          "<xmp:CreateDate>2026-08-15T17:56:04+03:00</xmp:CreateDate>",
          "<xmp:ModifyDate>2026-08-15T17:56:04+03:00</xmp:ModifyDate>",
          "<xmp:MetadataDate>2026-08-15T17:56:04+03:00</xmp:MetadataDate>",
          "<dc:date><rdf:Seq><rdf:li>2026-08-15T17:56:04+03:00</rdf:li></rdf:Seq></dc:date>",
          "/CreationDate(D:20260815175604+03'00')",
          "/ID [ <A335EE20CB831FE28287D9DB23DB822E>",
          "<A335EE20CB831FE28287D9DB23DB822E> ]",
          "%%EOF",
        ].join("\n"),
      );
      return { stdout: `convert ${stem}`, stderr: "" };
    },
    extractPdfText: async () => ({ stdout: "stable complete searchable text\n", stderr: "" }),
    validatePdf: async () => {
      validations += 1;
      if (validations === options.failValidationAt) throw new Error("synthetic PDF/A failure");
    },
  };
}

describe("legal artifact release generation", () => {
  it("recovers a stale owned generation lock and its exact interrupted staging directory", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");
    const staleTemporaryRoot = path.join(repositoryRoot, ".markiro-legal-build-stale-owned");
    await mkdir(staleTemporaryRoot);
    await writeFile(path.join(staleTemporaryRoot, "owned-marker"), "stale");
    await acquireArtifactGenerationLock({
      repositoryRoot,
      outDir,
      temporaryRoot: staleTemporaryRoot,
      processId: 41001,
      token: "a".repeat(32),
    });

    const replacementTemporaryRoot = path.join(repositoryRoot, ".markiro-legal-build-replacement");
    await mkdir(replacementTemporaryRoot);
    const replacement = await acquireArtifactGenerationLock({
      repositoryRoot,
      outDir,
      temporaryRoot: replacementTemporaryRoot,
      processId: 41002,
      token: "b".repeat(32),
      isProcessAlive: (processId) => processId !== 41001,
    });

    await expect(lstat(staleTemporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(repositoryRoot)).filter((entry) =>
        entry.startsWith(".markiro-legal-artifacts.owner-"),
      ),
    ).toEqual([`.markiro-legal-artifacts.owner-${"b".repeat(32)}.json`]);
    await replacement.release();
    await expect(lstat(artifactGenerationLockPath(repositoryRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a live owned generation lock without changing its identity", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");
    const firstTemporaryRoot = path.join(repositoryRoot, ".markiro-legal-build-first-live");
    const secondTemporaryRoot = path.join(repositoryRoot, ".markiro-legal-build-second-live");
    await Promise.all([mkdir(firstTemporaryRoot), mkdir(secondTemporaryRoot)]);
    const first = await acquireArtifactGenerationLock({
      repositoryRoot,
      outDir,
      temporaryRoot: firstTemporaryRoot,
      processId: 42001,
      token: "c".repeat(32),
    });
    const lockPath = artifactGenerationLockPath(repositoryRoot);
    const lockBefore = await lstat(lockPath);

    await expect(
      acquireArtifactGenerationLock({
        repositoryRoot,
        outDir,
        temporaryRoot: secondTemporaryRoot,
        processId: 42002,
        token: "d".repeat(32),
        isProcessAlive: (processId) => processId === 42001,
      }),
    ).rejects.toThrow("live legal artifact generation lock");
    const lockAfter = await lstat(lockPath);
    expect({ device: lockAfter.dev, inode: lockAfter.ino }).toEqual({
      device: lockBefore.dev,
      inode: lockBefore.ino,
    });
    await first.release();
  });

  it("refuses a foreign generation lock without deleting it or its staging data", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");
    const lockPath = artifactGenerationLockPath(repositoryRoot);
    const foreignTemporaryRoot = path.join(repositoryRoot, ".markiro-legal-build-foreign");
    await mkdir(foreignTemporaryRoot);
    await writeFile(path.join(foreignTemporaryRoot, "foreign-marker"), "keep");
    await writeFile(lockPath, "foreign lock data", { flag: "wx" });

    await expect(
      acquireArtifactGenerationLock({
        repositoryRoot,
        outDir,
        temporaryRoot: foreignTemporaryRoot,
        processId: 43001,
        token: "e".repeat(32),
        isProcessAlive: () => false,
      }),
    ).rejects.toThrow("foreign or malformed");
    await expect(readFile(lockPath, "utf8")).resolves.toBe("foreign lock data");
    await expect(readFile(path.join(foreignTemporaryRoot, "foreign-marker"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("pins the exact Writer PDF/A-2 export argument", () => {
    const args = libreOfficePdfExportArguments("/tmp/out", "/tmp/source.docx");
    expect(LIBREOFFICE_PDF_EXPORT_FILTER).toBe(
      'pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"2"},"UseTaggedPDF":{"type":"boolean","value":"true"},"EnableTextAccessForAccessibilityTools":{"type":"boolean","value":"true"},"ExportBookmarks":{"type":"boolean","value":"true"}}',
    );
    expect(args).toEqual([
      "--headless",
      "--convert-to",
      LIBREOFFICE_PDF_EXPORT_FILTER,
      "--outdir",
      "/tmp/out",
      "/tmp/source.docx",
    ]);
  });

  it("isolates LibreOffice in a writable task-local user profile", () => {
    const environment = libreOfficeEnvironment("/tmp/legal-profile", {
      PATH: "/usr/bin",
      HOME: "/Users/example",
      TMPDIR: "/not-writable",
    });
    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/legal-profile",
      TMPDIR: "/private/tmp",
      XDG_CACHE_HOME: "/tmp/legal-profile/xdg-cache",
      XDG_CONFIG_HOME: "/tmp/legal-profile/xdg-config",
    });
    expect(
      libreOfficeProfileDirectory(
        "/tmp/legal-build/release/files",
        "/tmp/legal-build/internal/markiro_mkr-pd-01_2026.08.01_ru.docx",
      ),
    ).toBe("/tmp/legal-build/internal/libreoffice-home/markiro_mkr-pd-01_2026.08.01_ru");
  });

  it.each([
    ["LibreOffice 26.2.5.2 60(Build:2)", false],
    ["LibreOfficeDev 26.8.0.0.alpha0", true],
  ])("accepts the appropriate LibreOffice version for its mode", (version, preview) => {
    expect(() => assertReleaseLibreOfficeVersion(version, preview)).not.toThrow();
  });

  it("rejects a non-26.2.5 LibreOffice build for a release", () => {
    expect(() => assertReleaseLibreOfficeVersion("LibreOfficeDev 26.8.0.0.alpha0", false)).toThrow(
      "26.2.5",
    );
  });

  it("accepts only a machine-readable conforming veraPDF result", () => {
    const compliant = JSON.stringify(compliantVeraPdfFixture());
    expect(() => parseVeraPdfValidationResult(compliant)).not.toThrow();
    const nonCompliant = compliantVeraPdfFixture();
    const validationResult = nonCompliant.report.jobs[0]?.validationResult[0];
    if (!validationResult) throw new Error("Fixture has no validation result");
    validationResult.compliant = false;
    nonCompliant.report.batchSummary.validationSummary.compliantPdfaCount = 0;
    nonCompliant.report.batchSummary.validationSummary.nonCompliantPdfaCount = 1;
    expect(() => parseVeraPdfValidationResult(JSON.stringify(nonCompliant))).toThrow(
      "not conformant",
    );
    expect(() => parseVeraPdfValidationResult("not json")).toThrow("machine-readable");
  });

  const contradictoryVeraPdfFixtures: readonly [string, (fixture: VeraPdfFixture) => void][] = [
    ["out-of-memory jobs", (fixture) => (fixture.report.batchSummary.outOfMemory = 1)],
    ["veraPDF exceptions", (fixture) => (fixture.report.batchSummary.veraExceptions = 1)],
    [
      "failed feature jobs",
      (fixture) => (fixture.report.batchSummary.featuresSummary.failedJobCount = 1),
    ],
    [
      "failed repair jobs",
      (fixture) => (fixture.report.batchSummary.repairSummary.failedJobCount = 1),
    ],
    ["multi-job mode", (fixture) => (fixture.report.batchSummary.multiJob = true)],
    ["encrypted jobs", (fixture) => (fixture.report.batchSummary.failedEncryptedJobs = 1)],
    ["parse failures", (fixture) => (fixture.report.batchSummary.failedParsingJobs = 1)],
    [
      "failed validation jobs",
      (fixture) => (fixture.report.batchSummary.validationSummary.failedJobCount = 1),
    ],
    [
      "noncompliant PDFs",
      (fixture) => (fixture.report.batchSummary.validationSummary.nonCompliantPdfaCount = 1),
    ],
    [
      "failed rules",
      (fixture) => {
        const result = fixture.report.jobs[0]?.validationResult[0];
        if (!result) throw new Error("Fixture has no validation result");
        result.details.failedRules = 1;
      },
    ],
    [
      "failed checks",
      (fixture) => {
        const result = fixture.report.jobs[0]?.validationResult[0];
        if (!result) throw new Error("Fixture has no validation result");
        result.details.failedChecks = 1;
      },
    ],
    [
      "an extra validation result",
      (fixture) => {
        const job = fixture.report.jobs[0];
        const result = job?.validationResult[0];
        if (!job || !result) throw new Error("Fixture has no validation result");
        job.validationResult.push(structuredClone(result));
      },
    ],
    [
      "an extra job",
      (fixture) => {
        const job = fixture.report.jobs[0];
        if (!job) throw new Error("Fixture has no job");
        fixture.report.jobs.push(structuredClone(job));
      },
    ],
  ];

  it.each(contradictoryVeraPdfFixtures)(
    "rejects a veraPDF result with %s despite a compliant result",
    (_case, mutate) => {
      const fixture = compliantVeraPdfFixture();
      mutate(fixture);
      expect(() => parseVeraPdfValidationResult(JSON.stringify(fixture))).toThrow("not conformant");
    },
  );

  it("requires searchable boundary text and Cyrillic", () => {
    const expected = [
      "Политика обработки персональных данных",
      "MKR-PD-01",
      "2026.08.01",
      "Богатырев Владислав Сергеевич",
      "1. Общие положения и оператор",
      "13. Редакции и применимый текст",
    ];
    expect(() => assertExtractedPdfText(expected.join("\n"), expected)).not.toThrow();
    expect(() => assertExtractedPdfText("only ascii searchable text", ["only ascii"])).toThrow(
      "Cyrillic",
    );
    expect(() => assertExtractedPdfText("Богатырев Владислав Сергеевич", expected)).toThrow(
      "missing required text",
    );
    expect(() =>
      assertExtractedPdfText("Контакт: hello@v-\nb.tech", ["hello@v-b.tech"]),
    ).not.toThrow();
    expect(() => assertExtractedPdfText("Контакт: hello@vb.tech", ["hello@v-b.tech"])).toThrow(
      "missing required text",
    );
  });

  it("rejects font-substitution warnings and zero-page PDFs", () => {
    expect(() => assertNoFontSubstitutionWarnings("", "convert ok")).not.toThrow();
    expect(() => assertNoFontSubstitutionWarnings("font substituted: Arial", "")).toThrow(
      "font substitution",
    );
    expect(parsePdfPageCount("Pages:          4\nPage size: A4")).toBe(4);
    expect(() => parsePdfPageCount("Pages:          0")).toThrow("page count");
  });

  it("requires the approved IBM Plex fonts to be embedded, subset, and Unicode-mapped", () => {
    const approvedFonts = [
      "name                                 type              encoding         emb sub uni object ID",
      "------------------------------------ ----------------- ---------------- --- --- --- ---------",
      "BAAAAA+IBMPlexSans-Regular           TrueType          WinAnsi          yes yes yes    105  0",
      "CAAAAA+IBMPlexSans-SemiBold          TrueType          WinAnsi          yes yes yes    110  0",
      "DAAAAA+IBMPlexMono-Regular           TrueType          WinAnsi          yes yes yes    115  0",
      "EAAAAA+IBMPlexMono-SemiBold          TrueType          WinAnsi          yes yes yes    120  0",
    ].join("\n");
    expect(() => assertEmbeddedPdfFonts(approvedFonts)).not.toThrow();

    const substituted = approvedFonts.replaceAll("IBMPlex", "Liberation");
    expect(() => assertEmbeddedPdfFonts(substituted)).toThrow("IBM Plex");

    const notEmbedded = approvedFonts.replace(
      "BAAAAA+IBMPlexSans-Regular           TrueType          WinAnsi          yes yes yes",
      "BAAAAA+IBMPlexSans-Regular           TrueType          WinAnsi          no  no  yes",
    );
    expect(() => assertEmbeddedPdfFonts(notEmbedded)).toThrow("embedded subset");
  });

  it("normalizes LibreOffice PDF dates and trailer IDs without changing byte length", () => {
    const pdf = (time: string, pdfTime: string, id: string) =>
      Buffer.from(
        [
          "%PDF-1.7",
          `<xmp:CreateDate>${time}</xmp:CreateDate>`,
          `<xmp:ModifyDate>${time}</xmp:ModifyDate>`,
          `<xmp:MetadataDate>${time}</xmp:MetadataDate>`,
          `<dc:date><rdf:Seq><rdf:li>${time}</rdf:li></rdf:Seq></dc:date>`,
          `/CreationDate(D:${pdfTime})`,
          `/ID [ <${id}>`,
          `<${id}> ]`,
          "%%EOF",
        ].join("\n"),
      );
    const first = pdf(
      "2026-08-15T17:56:04+03:00",
      "20260815175604+03'00'",
      "A335EE20CB831FE28287D9DB23DB822E",
    );
    const second = pdf(
      "2026-08-15T18:01:59+03:00",
      "20260815180159+03'00'",
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    );
    const identity = "markiro_mkr-pd-01_2026.08.01_ru.pdf";
    const expectedId = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 32)
      .toUpperCase();

    const normalizedFirst = normalizeLibreOfficePdf(first, "2026-08-15", identity);
    const normalizedSecond = normalizeLibreOfficePdf(second, "2026-08-15", identity);

    expect(normalizedFirst).toEqual(normalizedSecond);
    expect(normalizedFirst.byteLength).toBe(first.byteLength);
    expect(normalizedFirst.toString()).toContain("2026-08-15T00:00:00+00:00");
    expect(normalizedFirst.toString()).toContain("D:20260815000000+00'00'");
    expect(normalizedFirst.toString().match(new RegExp(expectedId, "g"))).toHaveLength(2);
    expect(first.toString()).toContain("17:56:04");
  });

  it("normalizes the PDF/A ICC timestamp and rebuilds a classic xref deterministically", () => {
    const first = pdfWithIccTimestamp(
      "2026-08-15T17:56:04+03:00",
      "20260815175604+03'00'",
      "A335EE20CB831FE28287D9DB23DB822E",
      [2026, 8, 15, 14, 56, 4],
    );
    const second = pdfWithIccTimestamp(
      "2026-08-15T18:01:59+03:00",
      "20260815180159+03'00'",
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      [2026, 8, 15, 15, 1, 59],
    );
    const identity = "markiro_mkr-pd-01_2026.08.01_ru.pdf";

    const normalizedFirst = normalizeLibreOfficePdf(first, "2026-08-15", identity);
    const normalizedSecond = normalizeLibreOfficePdf(second, "2026-08-15", identity);

    expect(first.byteLength).not.toBe(second.byteLength);
    expect(normalizedFirst).toEqual(normalizedSecond);
    const normalizedText = normalizedFirst.toString("latin1");
    const xrefOffset = Number(/startxref\n(\d+)\n%%EOF/.exec(normalizedText)?.[1]);
    expect(normalizedText.slice(xrefOffset, xrefOffset + 4)).toBe("xref");
  });

  it("canonicalizes LibreOffice embedded-font group permutations", () => {
    const argumentsForPdf = [
      "2026-08-15T17:56:04+03:00",
      "20260815175604+03'00'",
      "A335EE20CB831FE28287D9DB23DB822E",
      [2026, 8, 15, 14, 56, 4] as const,
    ] as const;
    const identity = "markiro_mkr-pd-01_2026.08.01_ru.pdf";
    const first = pdfWithIccTimestamp(...argumentsForPdf, false);
    const second = pdfWithIccTimestamp(...argumentsForPdf, true);

    expect(first).not.toEqual(second);
    expect(normalizeLibreOfficePdf(first, "2026-08-15", identity)).toEqual(
      normalizeLibreOfficePdf(second, "2026-08-15", identity),
    );
  });

  it("preserves PDF strings, comments, and name tokens while canonicalizing font references", () => {
    const argumentsForPdf = [
      "2026-08-15T17:56:04+03:00",
      "20260815175604+03'00'",
      "A335EE20CB831FE28287D9DB23DB822E",
      [2026, 8, 15, 14, 56, 4] as const,
    ] as const;
    const identity = "markiro_mkr-pd-01_2026.08.01_ru.pdf";
    const first = pdfWithIccTimestamp(...argumentsForPdf, false, true);
    const second = pdfWithIccTimestamp(...argumentsForPdf, true, true);
    const expectedProtectedContent = [
      "/Literal(keep 7 0 R nested (8 0 R) escaped \\(9 0 R\\))",
      "/Hex<313020302052>",
      "/7 0 R",
      "/7#20escaped 0 R",
      "% keep 11 0 R",
    ] as const;

    const normalizedFirst = normalizeLibreOfficePdf(first, "2026-08-15", identity);
    const normalizedSecond = normalizeLibreOfficePdf(second, "2026-08-15", identity);

    expect(normalizedFirst).toEqual(normalizedSecond);
    for (const protectedContent of expectedProtectedContent) {
      expect(first.toString("latin1")).toContain(protectedContent);
      expect(second.toString("latin1")).toContain(protectedContent);
      expect(normalizedFirst.toString("latin1")).toContain(protectedContent);
      expect(normalizedSecond.toString("latin1")).toContain(protectedContent);
    }
  });

  it("requires release output to be the selected public legal root", async () => {
    const repositoryRoot = await temporaryRoot();
    const publicRoot = path.join(repositoryRoot, "apps/landing/public/legal");
    expect(resolveGenerationOutput(publicRoot, repositoryRoot, false)).toBe(publicRoot);
    expect(() =>
      resolveGenerationOutput(path.join(repositoryRoot, "outside"), repositoryRoot, false),
    ).toThrow("public legal artifact root");
  });

  it("keeps preview output outside the tracked legal root", async () => {
    const repositoryRoot = await temporaryRoot();
    const publicRoot = path.join(repositoryRoot, "apps/landing/public/legal");
    expect(() => resolveGenerationOutput(publicRoot, repositoryRoot, true)).toThrow(
      "Preview output",
    );
    expect(
      resolveGenerationOutput(path.join(repositoryRoot, "preview"), repositoryRoot, true),
    ).toBe(path.join(repositoryRoot, "preview"));
  });

  it("rejects a symbolic-link output parent before writing through it", async () => {
    const repositoryRoot = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    await mkdir(path.join(repositoryRoot, "apps/landing"), { recursive: true });
    await symlink(outsideRoot, path.join(repositoryRoot, "apps/landing/public"), "dir");
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");

    await expect(
      generateLegalArtifacts(
        {
          repositoryRoot,
          outDir,
          sofficeBin: "/opt/libreoffice-26.2.5/program/soffice",
          preview: false,
          check: false,
        },
        fakeGenerationDependencies(),
      ),
    ).rejects.toThrow("symbolic-link ancestor");
    await expect(readdir(outsideRoot)).resolves.toEqual([]);
  });

  it("publishes one complete directory atomically after keeping public paths absent", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");
    const dependencies = fakeGenerationDependencies();
    let beforePublishCalls = 0;
    const observedDependencies = {
      ...dependencies,
      beforePublish: async () => {
        beforePublishCalls += 1;
        await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readdir(path.dirname(outDir))).resolves.toEqual([]);
        const lock = await lstat(path.join(repositoryRoot, ".markiro-legal-artifacts.lock"));
        expect(lock.isFile()).toBe(true);
      },
    } as ArtifactGenerationDependencies;

    const entries = await generateLegalArtifacts(
      {
        repositoryRoot,
        outDir,
        sofficeBin: "/opt/libreoffice-26.2.5/program/soffice",
        preview: false,
        check: false,
      },
      observedDependencies,
    );

    expect(beforePublishCalls).toBe(1);
    expect(entries).toHaveLength(12);
    expect(dependencies.converted).toHaveLength(8);
    expect(await readdir(path.dirname(outDir))).toEqual(["legal"]);
    expect(await readdir(outDir)).toEqual(["artifacts.json", "files"]);
    expect(await readdir(path.join(outDir, "files"))).toHaveLength(12);
    expect(await readFile(path.join(outDir, "artifacts.json"), "utf8")).toBe(
      canonicalArtifactManifest(entries),
    );
    expect(
      (await readdir(repositoryRoot)).filter((entry) => entry.startsWith(".markiro-legal-")),
    ).toEqual([]);
  });

  it("publishes nothing when one PDF validation fails", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");

    await expect(
      generateLegalArtifacts(
        {
          repositoryRoot,
          outDir,
          sofficeBin: "/opt/libreoffice-26.2.5/program/soffice",
          preview: false,
          check: false,
        },
        fakeGenerationDependencies({ failValidationAt: 4 }),
      ),
    ).rejects.toThrow("synthetic PDF/A failure");
    await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(repositoryRoot)).filter((entry) => entry.startsWith(".markiro-legal-")),
    ).toEqual([]);
  });

  it("rejects a complete raw-text mismatch across PDF canonicalization", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");
    let extractions = 0;
    const dependencies = {
      ...fakeGenerationDependencies(),
      extractPdfText: async () => {
        extractions += 1;
        return {
          stdout: extractions === 1 ? "complete text before\n" : "complete text after\n",
          stderr: "",
        };
      },
    };

    await expect(
      generateLegalArtifacts(
        {
          repositoryRoot,
          outDir,
          sofficeBin: "/opt/libreoffice-26.2.5/program/soffice",
          preview: false,
          check: false,
        },
        dependencies,
      ),
    ).rejects.toThrow("complete searchable text");
    expect(extractions).toBe(2);
    await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not clobber an empty destination created immediately before publication", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");
    const dependencies = fakeGenerationDependencies();
    let collisionIdentity: { readonly device: number; readonly inode: number } | undefined;
    const collisionDependencies = {
      ...dependencies,
      beforePublish: async () => {
        await mkdir(outDir);
        const collision = await lstat(outDir);
        collisionIdentity = { device: collision.dev, inode: collision.ino };
      },
    } as ArtifactGenerationDependencies;

    await expect(
      generateLegalArtifacts(
        {
          repositoryRoot,
          outDir,
          sofficeBin: "/opt/libreoffice-26.2.5/program/soffice",
          preview: false,
          check: false,
        },
        collisionDependencies,
      ),
    ).rejects.toThrow("already exists");
    await expect(readdir(outDir)).resolves.toEqual([]);
    const collisionAfterFailure = await lstat(outDir);
    expect({ device: collisionAfterFailure.dev, inode: collisionAfterFailure.ino }).toEqual(
      collisionIdentity,
    );
    await expect(readdir(path.dirname(outDir))).resolves.toEqual(["legal"]);
    expect(
      (await readdir(repositoryRoot)).filter((entry) => entry.startsWith(".markiro-legal-")),
    ).toEqual([]);
  });

  it("never overwrites a release and allows --check only for byte-identical output", async () => {
    const repositoryRoot = await temporaryRoot();
    const outDir = path.join(repositoryRoot, "apps/landing/public/legal");
    const generation = {
      repositoryRoot,
      outDir,
      sofficeBin: "/opt/libreoffice-26.2.5/program/soffice",
      preview: false,
      check: false,
    } as const;
    await generateLegalArtifacts(generation, fakeGenerationDependencies());

    await expect(generateLegalArtifacts(generation, fakeGenerationDependencies())).rejects.toThrow(
      "already exists",
    );
    await expect(
      generateLegalArtifacts({ ...generation, check: true }, fakeGenerationDependencies()),
    ).resolves.toHaveLength(12);

    const changed = path.join(outDir, "files", "markiro_mkr-pd-01_2026.08.01_ru.pdf");
    await writeFile(changed, "%PDF-1.7\nchanged\n%%EOF\n");
    await expect(
      generateLegalArtifacts({ ...generation, check: true }, fakeGenerationDependencies()),
    ).rejects.toThrow("not byte-identical");
  });
});
