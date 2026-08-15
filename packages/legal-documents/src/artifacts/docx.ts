import { renderLiteralDataMatrixSvg } from "@markiro/domain/artifacts";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  HeightRule,
  ImageRun,
  LevelFormat,
  PageNumber,
  Paragraph,
  Packer,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type FileChild,
  type IStylesOptions,
} from "docx";
import { unzipSync, zipSync } from "fflate";

import { OPERATOR_PROFILES } from "../operator.js";
import { formatLegalEffectiveDate } from "../identity.js";
import { findLegalDocument, findLegalRelease } from "../registry.js";
import type { LegalBlock } from "../types.js";
import {
  MARKIRO_COLORS,
  prepareDataMatrixMedia,
  renderMarkiroSymbolPng,
  renderMarkiroSymbolSvg,
} from "./brand.js";
import { assertLegalArtifactRequest, type LegalArtifactRequest } from "./names.js";

const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const PAGE_MARGIN = 1134;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const META_LABEL_WIDTH = 2835;
const META_VALUE_WIDTH = CONTENT_WIDTH - META_LABEL_WIDTH;
const HEADER_IDENTITY_WIDTH = 4535;
const HEADER_WORDMARK_WIDTH = CONTENT_WIDTH - HEADER_IDENTITY_WIDTH;
const FIRST_HEADER_HEIGHT = 520;
const DEFAULT_HEADER_HEIGHT = 400;
const FOOTER_HEIGHT = 620;
// 47 px at 96 DPI makes the inner 156/168 symbol 11.55 mm; the remaining
// 0.89 mm is the required external one-module quiet zone.
const DATA_MATRIX_IMAGE_SIZE = 47;
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: MARKIRO_COLORS.paper } as const;
const TABLE_BORDERS = {
  top: NO_BORDER,
  bottom: NO_BORDER,
  left: NO_BORDER,
  right: NO_BORDER,
  insideHorizontal: NO_BORDER,
  insideVertical: NO_BORDER,
} as const;

const copy = {
  ru: {
    documentClass: "ПУБЛИЧНЫЙ ДОКУМЕНТ",
    code: "Код документа",
    revision: "Редакция",
    effectiveDate: "Действует с",
    language: "Язык",
    operator: "Оператор",
    contacts: "Контакты",
    verification: "Проверка редакции",
    page: "Страница",
  },
  en: {
    documentClass: "PUBLIC DOCUMENT",
    code: "Document code",
    revision: "Revision",
    effectiveDate: "Effective from",
    language: "Language",
    operator: "Operator",
    contacts: "Contacts",
    verification: "Revision verification",
    page: "Page",
  },
} as const;

export async function renderLegalDocx(input: LegalArtifactRequest): Promise<Uint8Array> {
  assertLegalArtifactRequest(input);
  const release = findLegalRelease(input.code, input.revision);
  const source = findLegalDocument(input.code, input.revision).content[input.locale];
  const operator = OPERATOR_PROFILES[release.operatorProfileId];
  const markSvg = renderMarkiroSymbolSvg();
  const markPng = renderMarkiroSymbolPng();
  const dataMatrix = prepareDataMatrixMedia(renderLiteralDataMatrixSvg(input.verificationUrl));

  const document = new Document({
    title: source.title,
    subject: `${input.code}/${input.revision}`,
    creator: "Markiro",
    lastModifiedBy: "Markiro legal artifact generator",
    description: source.summary,
    revision: 1,
    features: { updateFields: true },
    styles: createStyles(),
    numbering: {
      config: [
        {
          reference: "legal-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 360, hanging: 240 } } },
            },
          ],
        },
        {
          reference: "legal-numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 420, hanging: 300 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          titlePage: true,
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
              header: 284,
              footer: 284,
              gutter: 0,
            },
          },
        },
        headers: {
          first: new Header({
            children: [
              createHeader(
                input,
                markSvg,
                markPng,
                FIRST_HEADER_HEIGHT,
                24,
                copy[input.locale].documentClass,
              ),
            ],
          }),
          default: new Header({
            children: [
              createHeader(
                input,
                markSvg,
                markPng,
                DEFAULT_HEADER_HEIGHT,
                20,
                copy[input.locale].documentClass,
              ),
            ],
          }),
        },
        footers: {
          first: new Footer({
            children: [createFooter(input, dataMatrix)],
          }),
          default: new Footer({
            children: [createFooter(input, dataMatrix)],
          }),
        },
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun(source.title)],
            spacing: { before: 220, after: 140 },
          }),
          new Paragraph({
            style: "DocumentSummary",
            children: [new TextRun(source.summary)],
            spacing: { after: 220 },
          }),
          createMetadataTable(input, operator),
          ...source.sections.flatMap((section) => [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun(section.heading)],
            }),
            ...section.blocks.flatMap((block) => renderBlock(block)),
          ]),
        ],
      },
    ],
  });

  return normalizeDocx(await Packer.toBuffer(document), input.effectiveDate);
}

function createStyles(): IStylesOptions {
  return {
    default: {
      document: {
        run: {
          font: "IBM Plex Sans",
          size: 20,
          color: MARKIRO_COLORS.ink,
        },
        paragraph: { spacing: { line: 260, after: 100 } },
      },
      title: {
        run: { font: "IBM Plex Sans", size: 40, bold: true, color: MARKIRO_COLORS.ink },
        paragraph: { spacing: { before: 0, after: 160 }, outlineLevel: 0 },
      },
      heading1: {
        run: { font: "IBM Plex Sans", size: 25, bold: true, color: MARKIRO_COLORS.ink },
        paragraph: { spacing: { before: 240, after: 90 }, keepNext: true, outlineLevel: 0 },
      },
      listParagraph: {
        run: { font: "IBM Plex Sans", size: 20, color: MARKIRO_COLORS.ink },
        paragraph: { spacing: { after: 70 } },
      },
    },
    paragraphStyles: [
      {
        id: "DocumentSummary",
        name: "Document Summary",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: "IBM Plex Sans", size: 21, color: MARKIRO_COLORS.muted },
        paragraph: { spacing: { line: 280 } },
      },
      {
        id: "MetaMono",
        name: "Metadata Mono",
        basedOn: "Normal",
        next: "Normal",
        run: { font: "IBM Plex Mono", size: 16, color: MARKIRO_COLORS.ink },
        paragraph: { spacing: { before: 0, after: 0, line: 220 } },
      },
      {
        id: "FurnitureMono",
        name: "Document Furniture Mono",
        basedOn: "Normal",
        next: "Normal",
        run: { font: "IBM Plex Mono", size: 14, color: MARKIRO_COLORS.ink },
        paragraph: { spacing: { before: 0, after: 0, line: 180 } },
      },
    ],
  };
}

function createHeader(
  input: LegalArtifactRequest,
  markSvg: string,
  markPng: Uint8Array,
  height: number,
  markSize: number,
  classLabel: string,
): Table {
  const localeWordmark = input.locale === "ru" ? "маркиро" : "MARKIRO";
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [HEADER_WORDMARK_WIDTH, HEADER_IDENTITY_WIDTH],
    layout: TableLayoutType.FIXED,
    borders: TABLE_BORDERS,
    rows: [
      new TableRow({
        height: { value: height, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            verticalAlign: VerticalAlign.CENTER,
            width: { size: HEADER_WORDMARK_WIDTH, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 40, right: 80 },
            borders: TABLE_BORDERS,
            children: [
              new Paragraph({
                spacing: { before: 0, after: 0 },
                children: [
                  createSvgImage(markSvg, markPng, markSize, "Markiro symbol"),
                  new TextRun({
                    text: `  ${localeWordmark}`,
                    font: "IBM Plex Mono",
                    bold: true,
                    size: markSize === 28 ? 25 : 20,
                    color: MARKIRO_COLORS.ink,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            verticalAlign: VerticalAlign.CENTER,
            width: { size: HEADER_IDENTITY_WIDTH, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 80, right: 40 },
            borders: TABLE_BORDERS,
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                style: "FurnitureMono",
                children: [
                  new TextRun({ text: classLabel, bold: true }),
                  new TextRun({ text: ` · ${input.code} · ${input.revision}` }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function createFooter(
  input: LegalArtifactRequest,
  dataMatrix: { readonly svg: string; readonly png: Uint8Array },
): Table {
  const labels = copy[input.locale];
  const effectiveDate = formatLegalEffectiveDate(input.effectiveDate, input.locale);
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [850, CONTENT_WIDTH - 850],
    layout: TableLayoutType.FIXED,
    borders: {
      ...TABLE_BORDERS,
      top: { style: BorderStyle.SINGLE, size: 4, color: MARKIRO_COLORS.line },
    },
    rows: [
      new TableRow({
        height: { value: FOOTER_HEIGHT, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            verticalAlign: VerticalAlign.CENTER,
            width: { size: 850, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 40, right: 120 },
            borders: TABLE_BORDERS,
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0 },
                children: [
                  createSvgImage(
                    dataMatrix.svg,
                    dataMatrix.png,
                    DATA_MATRIX_IMAGE_SIZE,
                    "Verification Data Matrix",
                  ),
                ],
              }),
            ],
          }),
          new TableCell({
            verticalAlign: VerticalAlign.CENTER,
            width: { size: CONTENT_WIDTH - 850, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 100, right: 40 },
            borders: TABLE_BORDERS,
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                style: "FurnitureMono",
                children: [
                  new TextRun({
                    text: `${input.code} · ${input.revision} · ${effectiveDate} · ${labels.page} `,
                    bold: true,
                  }),
                  new TextRun({ children: [PageNumber.CURRENT] }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function createSvgImage(
  svg: string,
  fallback: Uint8Array,
  size: number,
  description: string,
): ImageRun {
  return new ImageRun({
    type: "svg",
    data: new TextEncoder().encode(svg),
    fallback: { type: "png", data: fallback },
    transformation: { width: size, height: size },
    altText: { name: description, description, title: description },
  });
}

function createMetadataTable(
  input: LegalArtifactRequest,
  operator: (typeof OPERATOR_PROFILES)[keyof typeof OPERATOR_PROFILES],
): Table {
  const labels = copy[input.locale];
  const effectiveDate = formatLegalEffectiveDate(input.effectiveDate, input.locale);
  const rows = [
    [labels.code, input.code],
    [labels.revision, input.revision],
    [labels.effectiveDate, effectiveDate],
    [labels.verification, input.verificationUrl],
    [labels.language, input.locale.toUpperCase()],
    [labels.operator, operator.name],
    [labels.contacts, `${operator.site} · ${operator.email} · ${operator.phone}`],
  ] as const;
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [META_LABEL_WIDTH, META_VALUE_WIDTH],
    layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: MARKIRO_COLORS.line },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: MARKIRO_COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: MARKIRO_COLORS.line },
      right: { style: BorderStyle.SINGLE, size: 4, color: MARKIRO_COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: MARKIRO_COLORS.line },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: MARKIRO_COLORS.line },
    },
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              verticalAlign: VerticalAlign.CENTER,
              width: { size: META_LABEL_WIDTH, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: MARKIRO_COLORS.paper },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [new Paragraph({ style: "MetaMono", children: [new TextRun(label)] })],
            }),
            new TableCell({
              verticalAlign: VerticalAlign.CENTER,
              width: { size: META_VALUE_WIDTH, type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: value, font: "IBM Plex Sans", size: 18 })],
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

function renderBlock(block: LegalBlock): readonly FileChild[] {
  switch (block.kind) {
    case "paragraph":
      return [new Paragraph({ children: [new TextRun(block.text)] })];
    case "ordered-list":
    case "unordered-list":
      return block.items.map(
        (item) =>
          new Paragraph({
            style: "ListParagraph",
            numbering: {
              reference: block.kind === "ordered-list" ? "legal-numbers" : "legal-bullets",
              level: 0,
            },
            children: [new TextRun(item)],
          }),
      );
    case "definition-list":
      return block.items.map(
        ({ term, detail }) =>
          new Paragraph({
            children: [
              new TextRun({ text: term, bold: true }),
              new TextRun(" — "),
              new TextRun(detail),
            ],
          }),
      );
  }
}

function normalizeDocx(bytes: Uint8Array, effectiveDate: string): Uint8Array {
  const entries = unzipSync(bytes);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  for (const [name, value] of Object.entries(entries)) {
    if (!/^word\/(?:header|footer)\d+\.xml$/.test(name)) continue;
    entries[name] = encoder.encode(addNoWrapToIdentityCell(decoder.decode(value), name));
  }
  const core = entries["docProps/core.xml"];
  if (!core) throw new Error("Generated DOCX is missing core properties");
  const timestamp = `${effectiveDate}T00:00:00Z`;
  const coreXml = normalizeCorePropertyTimestamps(decoder.decode(core), timestamp);
  entries["docProps/core.xml"] = encoder.encode(coreXml);

  const sortedEntries = Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((name) => [name, entries[name] as Uint8Array]),
  );
  const normalized = zipSync(sortedEntries, { level: 9 });
  normalizeZipDates(normalized, effectiveDate);
  return normalized;
}

function addNoWrapToIdentityCell(xml: string, partName: string): string {
  const cellTag = "<w:tc>";
  const firstCellStart = xml.indexOf(cellTag);
  const identityCellStart = xml.indexOf(cellTag, firstCellStart + cellTag.length);
  const thirdCellStart = xml.indexOf(cellTag, identityCellStart + cellTag.length);
  if (firstCellStart < 0 || identityCellStart < 0 || thirdCellStart >= 0) {
    throw new Error(`Generated ${partName} must contain exactly two table cells`);
  }

  const identityCellEnd = xml.indexOf("</w:tc>", identityCellStart + cellTag.length);
  const propertiesStart = xml.indexOf("<w:tcPr>", identityCellStart + cellTag.length);
  const propertiesEnd = xml.indexOf("</w:tcPr>", propertiesStart + "<w:tcPr>".length);
  if (
    identityCellEnd < 0 ||
    propertiesStart < 0 ||
    propertiesEnd < 0 ||
    propertiesStart > identityCellEnd ||
    propertiesEnd > identityCellEnd
  ) {
    throw new Error(`Generated ${partName} identity cell has malformed properties`);
  }

  const propertiesXml = xml.slice(propertiesStart, propertiesEnd);
  if (propertiesXml.includes("<w:noWrap")) {
    throw new Error(`Generated ${partName} identity cell already has no-wrap properties`);
  }
  const marginsStart = xml.indexOf("<w:tcMar>", propertiesStart + "<w:tcPr>".length);
  if (marginsStart < 0 || marginsStart > propertiesEnd) {
    throw new Error(`Generated ${partName} identity cell is missing explicit margins`);
  }

  return `${xml.slice(0, marginsStart)}<w:noWrap/>${xml.slice(marginsStart)}`;
}

function isXmlWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function findXmlTagEnd(xml: string, start: number, qualifiedName: string): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
    if (character === "<") {
      throw new Error(`Generated DOCX has malformed ${qualifiedName} XML element`);
    }
  }
  throw new Error(`Generated DOCX has unterminated ${qualifiedName} XML element`);
}

function replaceXmlElementText(xml: string, qualifiedName: string, value: string): string {
  const openingPrefix = `<${qualifiedName}`;
  let openingStart = -1;
  let searchFrom = 0;
  while (searchFrom < xml.length) {
    const candidate = xml.indexOf(openingPrefix, searchFrom);
    if (candidate < 0) break;
    const delimiter = xml[candidate + openingPrefix.length];
    if (delimiter === ">" || isXmlWhitespace(delimiter)) {
      if (openingStart >= 0) {
        throw new Error(`Generated DOCX has duplicate ${qualifiedName} XML element`);
      }
      openingStart = candidate;
    }
    searchFrom = candidate + openingPrefix.length;
  }
  if (openingStart < 0) {
    throw new Error(`Generated DOCX is missing ${qualifiedName} XML element`);
  }

  const openingEnd = findXmlTagEnd(xml, openingStart + openingPrefix.length, qualifiedName);
  if (xml[openingEnd - 1] === "/") {
    throw new Error(`Generated DOCX has empty ${qualifiedName} XML element`);
  }
  const closingTag = `</${qualifiedName}>`;
  const closingStart = xml.indexOf(closingTag, openingEnd + 1);
  if (closingStart < 0) {
    throw new Error(`Generated DOCX is missing closing ${qualifiedName} XML element`);
  }
  if (xml.slice(openingEnd + 1, closingStart).includes("<")) {
    throw new Error(`Generated DOCX has nested XML element inside ${qualifiedName}`);
  }

  return `${xml.slice(0, openingEnd + 1)}${value}${xml.slice(closingStart)}`;
}

export function normalizeCorePropertyTimestamps(xml: string, timestamp: string): string {
  return replaceXmlElementText(
    replaceXmlElementText(xml, "dcterms:created", timestamp),
    "dcterms:modified",
    timestamp,
  );
}

export function normalizeZipDates(bytes: Uint8Array, effectiveDate: string): void {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveDate);
  const year = Number(dateMatch?.[1]);
  const month = Number(dateMatch?.[2]);
  const day = Number(dateMatch?.[3]);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1980 ||
    year > 2107 ||
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() + 1 !== month ||
    parsedDate.getUTCDate() !== day
  ) {
    throw new Error(`Legal artifact effective date is not representable in ZIP: ${effectiveDate}`);
  }
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = findEndOfCentralDirectory(view, bytes.byteLength);
  const centralEnd = directory.centralOffset + directory.centralSize;
  const timestampOffsets: { readonly central: number; readonly local: number }[] = [];
  let centralCursor = directory.centralOffset;

  for (let index = 0; index < directory.entryCount; index += 1) {
    assertZipRange(centralCursor, 46, centralEnd, "central directory record");
    if (view.getUint32(centralCursor, true) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory signature at entry ${index}`);
    }

    const compressedSize = view.getUint32(centralCursor + 20, true);
    const uncompressedSize = view.getUint32(centralCursor + 24, true);
    const nameLength = view.getUint16(centralCursor + 28, true);
    const extraLength = view.getUint16(centralCursor + 30, true);
    const commentLength = view.getUint16(centralCursor + 32, true);
    const diskStart = view.getUint16(centralCursor + 34, true);
    const localOffset = view.getUint32(centralCursor + 42, true);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      diskStart !== 0
    ) {
      throw new Error("ZIP64 and multi-disk legal artifacts are not supported");
    }

    const centralNameStart = centralCursor + 46;
    const centralRecordLength = 46 + nameLength + extraLength + commentLength;
    assertZipRange(centralCursor, centralRecordLength, centralEnd, "central directory entry");
    assertZipRange(localOffset, 30, directory.centralOffset, "referenced local header");
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header signature for central entry ${index}`);
    }

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localDataStart = localNameStart + localNameLength + localExtraLength;
    assertZipRange(
      localOffset,
      30 + localNameLength + localExtraLength + compressedSize,
      directory.centralOffset,
      "local file entry",
    );
    if (
      nameLength !== localNameLength ||
      !equalBytes(
        bytes.subarray(centralNameStart, centralNameStart + nameLength),
        bytes.subarray(localNameStart, localNameStart + localNameLength),
      )
    ) {
      throw new Error(`ZIP local and central names differ at entry ${index}`);
    }
    if (localDataStart + compressedSize > directory.centralOffset) {
      throw new Error(`ZIP local payload exceeds the central directory at entry ${index}`);
    }

    timestampOffsets.push({ central: centralCursor, local: localOffset });
    centralCursor += centralRecordLength;
  }

  if (centralCursor !== centralEnd) {
    throw new Error("ZIP central directory size does not match its declared entries");
  }
  for (const offsets of timestampOffsets) {
    view.setUint16(offsets.central + 12, 0, true);
    view.setUint16(offsets.central + 14, dosDate, true);
    view.setUint16(offsets.local + 10, 0, true);
    view.setUint16(offsets.local + 12, dosDate, true);
  }
}

function findEndOfCentralDirectory(
  view: DataView,
  byteLength: number,
): {
  readonly centralOffset: number;
  readonly centralSize: number;
  readonly entryCount: number;
} {
  if (byteLength < 22) throw new Error("Generated DOCX is too short to be a ZIP archive");
  const lowerBound = Math.max(0, byteLength - 65_557);
  for (let offset = byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength !== byteLength) continue;

    const diskNumber = view.getUint16(offset + 4, true);
    const centralDisk = view.getUint16(offset + 6, true);
    const diskEntries = view.getUint16(offset + 8, true);
    const entryCount = view.getUint16(offset + 10, true);
    const centralSize = view.getUint32(offset + 12, true);
    const centralOffset = view.getUint32(offset + 16, true);
    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== entryCount ||
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff ||
      centralOffset + centralSize !== offset ||
      entryCount * 46 > centralSize
    ) {
      continue;
    }
    return { centralOffset, centralSize, entryCount };
  }
  throw new Error("Generated DOCX has no valid single-disk ZIP central directory");
}

function assertZipRange(offset: number, length: number, limit: number, label: string): void {
  if (offset < 0 || length < 0 || offset > limit || length > limit - offset) {
    throw new Error(`Generated DOCX has an out-of-bounds ${label}`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
