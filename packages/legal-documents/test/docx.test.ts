import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import * as legalDocuments from "../src/index.js";
import {
  artifactFileName,
  describeLegalArtifact,
  renderLegalDocx,
  type LegalArtifactRequest,
} from "../src/artifacts/index.js";

const PRIVACY_REQUEST = {
  code: "MKR-PD-01",
  revision: "2026.08.01",
  effectiveDate: "2026-08-15",
  locale: "ru",
  kind: "legal-pdf",
  verificationUrl: "https://markiro.app/d/MKR-PD-01/2026.08.01/2026-08-15",
} as const satisfies LegalArtifactRequest;

const LETTERHEAD_REQUEST = {
  code: "MKR-BRD-01",
  revision: "2026.08.01",
  effectiveDate: "2026-08-15",
  locale: "ru",
  kind: "template-docx",
  verificationUrl: "https://markiro.app/d/MKR-BRD-01/2026.08.01/2026-08-15",
} as const satisfies LegalArtifactRequest;

const DPA_REQUEST = {
  code: "MKR-DPA-01",
  revision: "2026.08.01",
  effectiveDate: "2026-08-15",
  locale: "ru",
  kind: "template-docx",
  verificationUrl: "https://markiro.app/d/MKR-DPA-01/2026.08.01/2026-08-15",
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

function joinedXml(entries: Record<string, Uint8Array>, prefix: string): string {
  return Object.entries(entries)
    .filter(([name]) => name.startsWith(prefix) && name.endsWith(".xml"))
    .map(([, value]) => decoder.decode(value))
    .join("\n");
}

function centralDirectoryDosDates(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dates: number[] = [];
  for (let offset = 0; offset <= bytes.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    dates.push(view.getUint32(offset + 12, true));
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return dates;
}

describe("legal artifact descriptors", () => {
  it("derives stable lowercase release file names", () => {
    expect(artifactFileName(PRIVACY_REQUEST)).toBe("markiro_mkr-pd-01_2026.08.01_ru.pdf");
    expect(artifactFileName(LETTERHEAD_REQUEST)).toBe("markiro_mkr-brd-01_2026.08.01_ru.docx");
    expect(artifactFileName(DPA_REQUEST)).toBe("markiro_mkr-dpa-01_2026.08.01_ru.docx");
    expect(describeLegalArtifact(LETTERHEAD_REQUEST)).toEqual({
      ...LETTERHEAD_REQUEST,
      fileName: "markiro_mkr-brd-01_2026.08.01_ru.docx",
    });
  });

  it.each([
    [{ ...PRIVACY_REQUEST, locale: "RU" }, "locale"],
    [{ ...PRIVACY_REQUEST, revision: "2026.08.01/../secret" }, "release"],
    [{ ...PRIVACY_REQUEST, verificationUrl: `${PRIVACY_REQUEST.verificationUrl} secret` }, "URL"],
    [{ ...PRIVACY_REQUEST, revision: "2026.08.02" }, "release"],
    [{ ...PRIVACY_REQUEST, effectiveDate: "2026-08-16" }, "release"],
    [{ ...PRIVACY_REQUEST, kind: "template-docx" }, "template"],
  ])("rejects an unsafe or non-current descriptor %#", (request, message) => {
    expect(() => artifactFileName(request as LegalArtifactRequest)).toThrow(message);
  });

  it("keeps render-only dependencies outside the root entry", () => {
    expect(legalDocuments).not.toHaveProperty("renderLegalDocx");
    expect(legalDocuments).not.toHaveProperty("artifactFileName");
  });
});

describe("deterministic branded DOCX", () => {
  it("renders compact A4 legal-source structure from the released content", async () => {
    const bytes = await renderLegalDocx(PRIVACY_REQUEST);
    const entries = docxEntries(bytes);
    const documentXml = xml(entries, "word/document.xml");
    const headerXml = joinedXml(entries, "word/header");
    const footerXml = joinedXml(entries, "word/footer");
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
    expect(headerXml).toContain("маркиро");
    expect(footerXml).toContain("MKR-PD-01");
    expect(footerXml).toContain("2026.08.01");
    expect(footerXml).toContain("PAGE");
    expect(footerXml).toContain(PRIVACY_REQUEST.verificationUrl);
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
    expect(headerXml).toContain('<w:trHeight w:val="680" w:hRule="exact"/>');
    expect(headerXml).toContain('<w:trHeight w:val="510" w:hRule="exact"/>');
    expect(footerXml).toContain('<w:trHeight w:val="907" w:hRule="exact"/>');
    expect(footerXml).toContain('<w:trHeight w:val="794" w:hRule="exact"/>');

    expect(stylesXml).toContain('w:ascii="IBM Plex Sans"');
    expect(stylesXml).toContain('w:ascii="IBM Plex Mono"');
    expect(documentXml).toContain('<w:pStyle w:val="Title"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toMatch(
      /<w:tblGrid><w:gridCol w:w="2835"\/><w:gridCol w:w="6803"\/><\/w:tblGrid>/,
    );
    expect(allXml).toContain('descr="Markiro symbol"');
    expect(allXml).toContain('descr="Verification Data Matrix"');
    expect(allXml).toContain('<wp:extent cx="419100" cy="419100"/>');
    expect(markSvg?.match(/<rect /g)).toHaveLength(9);
    expect(markSvg).toContain('<rect x="26" y="42" width="8" height="8" fill="#3DDC7A"/>');
    expect(dataMatrixSvg).toContain('viewBox="-6 -6 168 168"');
    expect(dataMatrixSvg).toContain(
      '<rect x="-6" y="-6" width="168" height="168" fill="#FFFFFF"/>',
    );

    expect(coreXml).toContain("2026-08-15T00:00:00Z");
    expect(coreXml.match(/2026-08-15T00:00:00Z/g)).toHaveLength(2);
  });

  it("preserves the exact warning in downloadable templates", async () => {
    const entries = docxEntries(await renderLegalDocx(LETTERHEAD_REQUEST));
    expect(xml(entries, "word/document.xml")).toContain(
      "ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ. Бланк становится частью документа только после заполнения, проверки и оформления уполномоченным лицом.",
    );
  });

  it("emits sorted ZIP entries with fixed dates and byte-identical output", async () => {
    const first = await renderLegalDocx(PRIVACY_REQUEST);
    const second = await renderLegalDocx(PRIVACY_REQUEST);
    const entryNames = Object.keys(docxEntries(first));

    expect(first).toEqual(second);
    expect(entryNames).toEqual([...entryNames].sort());
    expect(centralDirectoryDosDates(first)).not.toHaveLength(0);
    expect(new Set(centralDirectoryDosDates(first))).toEqual(new Set([0x5d0f0000]));
  });
});
