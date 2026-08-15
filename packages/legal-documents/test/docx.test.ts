import { renderLiteralDataMatrixSvg } from "@markiro/domain/artifacts";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import * as legalDocuments from "../src/index.js";
import {
  artifactFileName,
  renderLegalDocx,
  type LegalArtifactRequest,
} from "../src/artifacts/index.js";
import { normalizeCorePropertyTimestamps, normalizeZipDates } from "../src/artifacts/docx.js";

const PRIVACY_REQUEST = {
  code: "MKR-PD-01",
  revision: "2026.08/01",
  effectiveDate: "2026-08-15",
  locale: "ru",
  kind: "legal-pdf",
  verificationUrl: "https://markiro.app/d/MKR-PD-01/2026.08/01/2026-08-15",
} as const satisfies LegalArtifactRequest;

const LETTERHEAD_REQUEST = {
  code: "MKR-BRD-01",
  revision: "2026.08/01",
  effectiveDate: "2026-08-15",
  locale: "ru",
  kind: "template-docx",
  verificationUrl: "https://markiro.app/d/MKR-BRD-01/2026.08/01/2026-08-15",
} as const satisfies LegalArtifactRequest;

const DPA_REQUEST = {
  code: "MKR-DPA-01",
  revision: "2026.08/01",
  effectiveDate: "2026-08-15",
  locale: "ru",
  kind: "template-docx",
  verificationUrl: "https://markiro.app/d/MKR-DPA-01/2026.08/01/2026-08-15",
} as const satisfies LegalArtifactRequest;

const CONSENT_REQUEST = {
  code: "MKR-PD-02",
  revision: "2026.08/01",
  effectiveDate: "2026-08-15",
  locale: "ru",
  kind: "legal-pdf",
  verificationUrl: "https://markiro.app/d/MKR-PD-02/2026.08/01/2026-08-15",
} as const satisfies LegalArtifactRequest;

const decoder = new TextDecoder();

function docxEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

function xml(entries: Record<string, Uint8Array>, name: string): string {
  const value = entries[name];
  if (!value) throw new Error(`Missing DOCX entry: ${name}`);
  return decoder.decode(value);
}

function xmlParts(entries: Record<string, Uint8Array>, prefix: string): readonly string[] {
  return Object.entries(entries)
    .filter(([name]) => name.startsWith(prefix) && name.endsWith(".xml"))
    .map(([, value]) => decoder.decode(value));
}

function xmlElements(value: string, qualifiedName: string): readonly string[] {
  return [
    ...value.matchAll(
      new RegExp(`<${qualifiedName}(?: [^>]*)?>[\\s\\S]*?</${qualifiedName}>`, "g"),
    ),
  ].map(([element]) => element);
}

function visibleXmlText(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function expectCenteredPaddedCells(value: string): void {
  const cells = xmlElements(value, "w:tc");
  expect(cells).not.toHaveLength(0);
  for (const cell of cells) {
    expect(cell).toContain('<w:vAlign w:val="center"/>');
    expect(cell).toMatch(
      /<w:tcMar><w:top w:type="dxa" w:w="\d+"\/><w:left w:type="dxa" w:w="\d+"\/><w:bottom w:type="dxa" w:w="\d+"\/><w:right w:type="dxa" w:w="\d+"\/><\/w:tcMar>/,
    );
  }
}

interface TestCentralRecord {
  readonly crc: number;
  readonly dateTime: number;
  readonly localOffset: number;
  readonly name: string;
}

function readCentralRecords(bytes: Uint8Array): readonly TestCentralRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 65_557);
    offset -= 1
  ) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Test ZIP parser could not locate EOCD");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const records: TestCentralRecord[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    records.push({
      crc: view.getUint32(offset + 16, true),
      dateTime: view.getUint32(offset + 12, true),
      localOffset: view.getUint32(offset + 42, true),
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(centralOffset + centralSize);
  return records;
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of input) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function expectIndependentZipIntegrity(bytes: Uint8Array): void {
  const entries = unzipSync(bytes);
  const records = readCentralRecords(bytes);
  expect(records).toHaveLength(Object.keys(entries).length);
  for (const record of records) {
    const entry = entries[record.name];
    if (!entry) throw new Error(`ZIP central record has no extracted entry: ${record.name}`);
    expect(crc32(entry), record.name).toBe(record.crc);
  }
}

function svgPath(svg: string): string {
  const path = /<path d="[^"]+"[^>]*fill="#000000"[^>]*\/>/.exec(svg)?.[0];
  if (!path) throw new Error("Missing Data Matrix SVG path");
  return path;
}

describe("legal artifact descriptors", () => {
  it.each([
    [{ ...PRIVACY_REQUEST, locale: "RU" }, "locale"],
    [{ ...PRIVACY_REQUEST, revision: "2026.08.01/../secret" }, "release"],
    [{ ...PRIVACY_REQUEST, verificationUrl: `${PRIVACY_REQUEST.verificationUrl} secret` }, "URL"],
    [{ ...PRIVACY_REQUEST, revision: "2026.08.02" }, "release"],
    [{ ...PRIVACY_REQUEST, effectiveDate: "2026-08-16" }, "release"],
  ])("rejects an unsafe or non-current descriptor %#", (request, message) => {
    expect(() => artifactFileName(request as LegalArtifactRequest)).toThrow(message);
  });

  it.each([PRIVACY_REQUEST, CONSENT_REQUEST])(
    "rejects a $code downloadable DOCX request",
    (request) => {
      expect(() => artifactFileName({ ...request, kind: "template-docx" })).toThrow("template");
    },
  );

  it("keeps render-only dependencies outside the root entry", () => {
    expect(legalDocuments).not.toHaveProperty("renderLegalDocx");
    expect(legalDocuments).not.toHaveProperty("artifactFileName");
  });
});

describe("deterministic branded DOCX", () => {
  it("rejects repeated core-property elements instead of scanning repeated XML prefixes", () => {
    const coreXml = [
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/">',
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-08-15T10:00:00Z</dcterms:created>',
      '<dcterms:modified xsi:type="dcterms:W3CDTF">'.repeat(4_096),
      "2026-08-15T10:00:00Z",
      "</dcterms:modified>".repeat(4_096),
      "</cp:coreProperties>",
    ].join("");

    expect(() => normalizeCorePropertyTimestamps(coreXml, "2026-08-15T00:00:00Z")).toThrow(
      "duplicate dcterms:modified XML element",
    );
  });

  it("renders compact A4 legal-source structure from the released content", async () => {
    const bytes = await renderLegalDocx(PRIVACY_REQUEST);
    const entries = docxEntries(bytes);
    const documentXml = xml(entries, "word/document.xml");
    const headerXmls = xmlParts(entries, "word/header");
    const footerXmls = xmlParts(entries, "word/footer");
    const headerXml = headerXmls.join("\n");
    const footerXml = footerXmls.join("\n");
    const relationshipsXml = Object.entries(entries)
      .filter(([name]) => name.includes("_rels/") && name.endsWith(".rels"))
      .map(([, value]) => decoder.decode(value))
      .join("\n");
    const stylesXml = xml(entries, "word/styles.xml");
    const coreXml = xml(entries, "docProps/core.xml");
    const allXml = Object.entries(entries)
      .filter(([name]) => name.endsWith(".xml") || name.endsWith(".rels"))
      .map(([, value]) => decoder.decode(value))
      .join("\n");
    const mediaNames = Object.keys(entries)
      .filter((name) => name.startsWith("word/media/"))
      .join("\n");
    const mediaSvgs = Object.entries(entries)
      .filter(([name]) => name.startsWith("word/media/") && name.endsWith(".svg"))
      .map(([, value]) => decoder.decode(value));
    const markSvg = mediaSvgs.find((value) => value.includes('viewBox="0 0 64 64"'));
    const dataMatrixSvg = mediaSvgs.find((value) => value.includes('fill="#FFFFFF"'));

    expect(documentXml).toContain("Политика обработки персональных данных");
    const identity = "ПУБЛИЧНЫЙ ДОКУМЕНТ · MKR-PD-01 · 2026.08/01";
    expect(headerXmls).toHaveLength(2);
    for (const part of headerXmls) {
      expect(part).toContain("маркиро");
      expect(xmlElements(part, "w:p").map(visibleXmlText)).toContain(identity);
      expect(part).toContain(
        '<w:tblGrid><w:gridCol w:w="5103"/><w:gridCol w:w="4535"/></w:tblGrid>',
      );
      expect(xmlElements(part, "w:tc")).toHaveLength(2);
      expect(part).not.toContain("<w:br");
      expect(part.match(/<w:wordWrap w:val="0"\/>/g)).toHaveLength(1);
      expect(part).not.toContain(PRIVACY_REQUEST.verificationUrl);
      expectCenteredPaddedCells(part);
    }
    expect(footerXmls).toHaveLength(2);
    for (const part of footerXmls) {
      expect(part).toContain("MKR-PD-01 · 2026.08/01 · 15.08.2026 · Страница ");
      expect(part).toContain("PAGE");
      expect(part).toContain('descr="Verification Data Matrix"');
      expect(part).not.toContain(PRIVACY_REQUEST.verificationUrl);
      expect(xmlElements(part, "w:tc")).toHaveLength(2);
      expectCenteredPaddedCells(part);
    }
    expect(mediaNames).not.toMatch(/signature|seal|stamp/i);
    expect(allXml).not.toMatch(/Роскомнадзор.*уведомлени[ея] подан/i);
    expect(allXml).not.toContain("ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ");

    expect(Object.keys(entries).filter((name) => /^word\/header\d+\.xml$/.test(name))).toHaveLength(
      2,
    );
    expect(Object.keys(entries).filter((name) => /^word\/footer\d+\.xml$/.test(name))).toHaveLength(
      2,
    );
    expect(documentXml).toContain("<w:titlePg/>");
    expect(documentXml).toMatch(/<w:headerReference w:type="default" r:id="rId\d+"\/>/);
    expect(documentXml).toMatch(/<w:headerReference w:type="first" r:id="rId\d+"\/>/);
    expect(documentXml).toMatch(/<w:footerReference w:type="default" r:id="rId\d+"\/>/);
    expect(documentXml).toMatch(/<w:footerReference w:type="first" r:id="rId\d+"\/>/);
    expect(relationshipsXml).toContain("relationships/header");
    expect(relationshipsXml).toContain("relationships/footer");
    expect(relationshipsXml).toContain("relationships/image");

    expect(documentXml).toMatch(/<w:pgSz w:w="11906" w:h="16838"[^>]*\/>/);
    expect(documentXml).toMatch(
      /<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="284" w:footer="284"[^>]*\/>/,
    );
    const headerHeights = [
      ...headerXml.matchAll(/<w:trHeight w:val="(\d+)" w:hRule="atLeast"\/>/g),
    ].map(([, value]) => Number(value));
    const footerHeights = [
      ...footerXml.matchAll(/<w:trHeight w:val="(\d+)" w:hRule="atLeast"\/>/g),
    ].map(([, value]) => Number(value));
    expect(headerHeights).toHaveLength(2);
    expect(Math.max(...headerHeights)).toBeLessThanOrEqual(520);
    expect(footerHeights).toHaveLength(2);
    expect(Math.max(...footerHeights)).toBeLessThanOrEqual(620);
    expect(footerXml).toMatch(/<w:spacing(?=[^>]*w:before="0")(?=[^>]*w:after="0")[^>]*\/>/);

    expect(stylesXml).toContain('w:ascii="IBM Plex Sans"');
    expect(stylesXml).toContain('w:ascii="IBM Plex Mono"');
    expect(documentXml).toContain('<w:pStyle w:val="Title"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toMatch(
      /<w:tblGrid><w:gridCol w:w="2835"\/><w:gridCol w:w="6803"\/><\/w:tblGrid>/,
    );
    const metadataTable = xmlElements(documentXml, "w:tbl").find((table) =>
      table.includes(PRIVACY_REQUEST.verificationUrl),
    );
    if (!metadataTable) throw new Error("Missing first-page verification metadata table");
    expect(metadataTable).toContain("Редакция");
    expect(metadataTable).toContain("2026.08/01");
    expect(metadataTable).toContain("Действует с");
    expect(metadataTable).toContain("15.08.2026");
    expect(metadataTable).toContain("Проверка редакции");
    expect(metadataTable).toContain(PRIVACY_REQUEST.verificationUrl);
    expect(metadataTable).not.toContain("<w:trHeight");
    expect(documentXml.match(new RegExp(PRIVACY_REQUEST.verificationUrl, "g"))).toHaveLength(1);
    expect(documentXml).toMatch(
      /<w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">Персональные данные<\/w:t><\/w:r><w:r><w:t xml:space="preserve"> — <\/w:t><\/w:r>/,
    );
    expect(documentXml).not.toContain("Персональные данные. ");
    expect(allXml).toContain('descr="Markiro symbol"');
    expect(allXml).toContain('descr="Verification Data Matrix"');
    expect(markSvg?.match(/<rect /g)).toHaveLength(9);
    expect(markSvg).toContain('<rect x="26" y="42" width="8" height="8" fill="#3DDC7A"/>');
    expect(dataMatrixSvg).toContain('viewBox="-6 -6 168 168"');
    expect(dataMatrixSvg).toContain(
      '<rect x="-6" y="-6" width="168" height="168" fill="#FFFFFF"/>',
    );
    if (!dataMatrixSvg) throw new Error("Missing embedded Data Matrix SVG");
    expect(svgPath(dataMatrixSvg)).toBe(
      svgPath(renderLiteralDataMatrixSvg(PRIVACY_REQUEST.verificationUrl)),
    );

    const dataMatrixExtent = /<wp:extent cx="(\d+)" cy="\1"\/>/.exec(footerXml)?.[1];
    if (!dataMatrixExtent) throw new Error("Missing Data Matrix drawing extent");
    const wholeImageMm = Number(dataMatrixExtent) / 36_000;
    const innerSymbolMm = wholeImageMm * (156 / 168);
    expect(innerSymbolMm).toBeGreaterThanOrEqual(11);
    expect(innerSymbolMm).toBeLessThanOrEqual(12);
    expect(wholeImageMm).toBeLessThanOrEqual(14);

    expect(coreXml).toContain("2026-08-15T00:00:00Z");
    expect(coreXml.match(/2026-08-15T00:00:00Z/g)).toHaveLength(2);
  });

  it("localizes English metadata and footer identity without exposing the URL in furniture", async () => {
    const request = { ...PRIVACY_REQUEST, locale: "en" } as const satisfies LegalArtifactRequest;
    const entries = docxEntries(await renderLegalDocx(request));
    const documentXml = xml(entries, "word/document.xml");
    const footerXmls = xmlParts(entries, "word/footer");
    const metadataTable = xmlElements(documentXml, "w:tbl").find((table) =>
      table.includes(request.verificationUrl),
    );

    if (!metadataTable) throw new Error("Missing English verification metadata table");
    expect(metadataTable).toContain("Revision");
    expect(metadataTable).toContain("2026.08/01");
    expect(metadataTable).toContain("Effective from");
    expect(metadataTable).toContain("15 August 2026");
    expect(metadataTable).toContain("Revision verification");
    expect(metadataTable).toContain(request.verificationUrl);
    expect(footerXmls).toHaveLength(2);
    for (const footerXml of footerXmls) {
      expect(footerXml).toContain("MKR-PD-01 · 2026.08/01 · 15 August 2026 · Page ");
      expect(footerXml).toContain("PAGE");
      expect(footerXml).not.toContain(request.verificationUrl);
    }
  });

  it("omits template warnings from privacy and consent internal source renders", async () => {
    const documents = await Promise.all(
      [PRIVACY_REQUEST, CONSENT_REQUEST].map(async (request) =>
        xml(docxEntries(await renderLegalDocx(request)), "word/document.xml"),
      ),
    );
    for (const document of documents) {
      expect(document).not.toContain("ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ");
    }
  });

  it("preserves the exact warning in DPA and brand downloadable templates", async () => {
    const [dpaDocument, letterheadDocument] = await Promise.all(
      [DPA_REQUEST, LETTERHEAD_REQUEST].map(async (request) =>
        xml(docxEntries(await renderLegalDocx(request)), "word/document.xml"),
      ),
    );
    expect(dpaDocument).toContain(
      "ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ. Этот текст не создает поручение до заполнения сведений о сторонах, целях, категориях субъектов и данных, сроках, специальных инструкциях и до оформления сторонами согласованным способом.",
    );
    expect(letterheadDocument).toContain(
      "ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ. Бланк становится частью документа только после заполнения, проверки и оформления уполномоченным лицом.",
    );
  });

  it("emits sorted ZIP entries with fixed dates and byte-identical output", async () => {
    const first = await renderLegalDocx(PRIVACY_REQUEST);
    const second = await renderLegalDocx(PRIVACY_REQUEST);
    const entryNames = Object.keys(docxEntries(first));

    expect(first).toEqual(second);
    expect(entryNames).toEqual([...entryNames].sort());
    const centralRecords = readCentralRecords(first);
    expect(centralRecords).not.toHaveLength(0);
    expect(new Set(centralRecords.map(({ dateTime }) => dateTime))).toEqual(new Set([0x5d0f0000]));
    expectIndependentZipIntegrity(first);
  });

  it("normalizes only declared ZIP records and preserves payload CRCs", () => {
    const payload = new Uint8Array(80);
    new DataView(payload.buffer).setUint32(8, 0x02014b50, true);
    const archive = zipSync({ "payload.bin": payload }, { level: 0 });

    normalizeZipDates(archive, "2026-08-15");

    expect(unzipSync(archive)["payload.bin"]).toEqual(payload);
    expectIndependentZipIntegrity(archive);
  });

  it("does not partially mutate a malformed ZIP archive", () => {
    const archive = zipSync({
      "first.txt": new Uint8Array([1]),
      "second.txt": new Uint8Array([2]),
    });
    const secondRecord = readCentralRecords(archive)[1];
    if (!secondRecord) throw new Error("Test ZIP is missing its second record");
    archive[secondRecord.localOffset] = 0;
    const malformedBytes = archive.slice();

    expect(() => normalizeZipDates(archive, "2026-08-15")).toThrow("local header signature");
    expect(archive).toEqual(malformedBytes);
  });
});
