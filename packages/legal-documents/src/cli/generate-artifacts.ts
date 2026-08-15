import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { unzlibSync, zlibSync } from "fflate";

import { renderLegalDocx } from "../artifacts/docx.js";
import type { LegalArtifactRequest } from "../artifacts/names.js";
import { artifactFileName } from "../artifacts/names.js";
import { legalVerificationUrl } from "../identity.js";
import { OPERATOR_PROFILES } from "../operator.js";
import { findLegalDocument, LEGAL_RELEASES } from "../registry.js";
import type { LegalBlock, LegalDocumentCode } from "../types.js";
import {
  MAX_LEGAL_PDF_BYTES,
  canonicalArtifactManifest,
  verifyArtifactManifest,
  type PublishedLegalArtifact,
} from "./verify-artifacts.js";

const execFile = promisify(execFileCallback);
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
const TEMPLATE_CODES = new Set<LegalDocumentCode>(["MKR-DPA-01", "MKR-BRD-01"]);
const RELEASE_LIBREOFFICE_VERSION = "26.2.5";
const VERAPDF_VERSION = "1.30.2";

export const VERAPDF_RELEASE_IMAGE =
  "docker.io/verapdf/cli@sha256:d5ee329657cf9bc4b2400392dd54c7d0a0ce9980ff6fa2da5590eebeec007cdb";

export const LIBREOFFICE_PDF_EXPORT_FILTER =
  'pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"2"},"UseTaggedPDF":{"type":"boolean","value":"true"},"EnableTextAccessForAccessibilityTools":{"type":"boolean","value":"true"},"ExportBookmarks":{"type":"boolean","value":"true"}}';

export interface ArtifactGenerationOptions {
  readonly repositoryRoot: string;
  readonly outDir: string;
  readonly sofficeBin: string;
  readonly preview: boolean;
  readonly check: boolean;
}

interface ConversionResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ConvertPdfInput {
  readonly sofficeBin: string;
  readonly sourcePath: string;
  readonly outputDirectory: string;
}

interface ValidatePdfInput {
  readonly pdfPath: string;
  readonly request: LegalArtifactRequest;
  readonly conversion: ConversionResult;
  readonly extractedText: string;
}

export interface ArtifactGenerationDependencies {
  readonly getLibreOfficeVersion: (sofficeBin: string) => Promise<string>;
  readonly renderDocx: (request: LegalArtifactRequest) => Promise<Uint8Array>;
  readonly convertPdf: (input: ConvertPdfInput) => Promise<ConversionResult>;
  readonly extractPdfText: (pdfPath: string) => Promise<ConversionResult>;
  readonly validatePdf: (input: ValidatePdfInput) => Promise<void>;
  readonly beforePublish?: (outDir: string) => Promise<void>;
}

export interface AcquireArtifactGenerationLockOptions {
  readonly repositoryRoot: string;
  readonly outDir: string;
  readonly temporaryRoot: string;
  readonly processId?: number;
  readonly token?: string;
  readonly isProcessAlive?: (processId: number) => boolean;
}

export interface ArtifactGenerationLock {
  readonly release: () => Promise<void>;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function resolveGenerationOutput(
  requestedOutput: string,
  repositoryRoot: string,
  preview: boolean,
): string {
  const root = path.resolve(repositoryRoot);
  const output = path.resolve(requestedOutput);
  const publicRoot = path.join(root, "apps/landing/public/legal");
  if (preview) {
    if (pathIsInside(publicRoot, output)) {
      throw new Error("Preview output must remain outside the tracked public legal artifact root");
    }
    return output;
  }
  if (output !== publicRoot) {
    throw new Error(
      `Release output must be the repository public legal artifact root: ${publicRoot}`,
    );
  }
  return output;
}

export function libreOfficePdfExportArguments(
  outputDirectory: string,
  sourcePath: string,
): readonly string[] {
  return [
    "--headless",
    "--convert-to",
    LIBREOFFICE_PDF_EXPORT_FILTER,
    "--outdir",
    outputDirectory,
    sourcePath,
  ];
}

export function libreOfficeEnvironment(
  profileDirectory: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    HOME: profileDirectory,
    TMPDIR: process.platform === "darwin" ? "/private/tmp" : "/tmp",
    XDG_CACHE_HOME: path.join(profileDirectory, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(profileDirectory, "xdg-config"),
  };
}

export function libreOfficeProfileDirectory(outputDirectory: string, sourcePath: string): string {
  const releaseRoot = path.dirname(outputDirectory);
  if (path.basename(outputDirectory) !== "files" || path.basename(releaseRoot) !== "release") {
    throw new Error(
      "LibreOffice release conversion output must be the staged release/files directory",
    );
  }
  return path.join(
    path.dirname(releaseRoot),
    "internal",
    "libreoffice-home",
    path.basename(sourcePath, ".docx"),
  );
}

export function assertReleaseLibreOfficeVersion(versionOutput: string, preview: boolean): void {
  const version = /LibreOffice(?:Dev)?\s+(\d+\.\d+\.\d+)/.exec(versionOutput)?.[1];
  if (!version) throw new Error(`Could not determine LibreOffice version from: ${versionOutput}`);
  if (!preview && version !== RELEASE_LIBREOFFICE_VERSION) {
    throw new Error(
      `Release generation requires LibreOffice ${RELEASE_LIBREOFFICE_VERSION}; received ${version}`,
    );
  }
}

export function assertNoFontSubstitutionWarnings(stdout: string, stderr: string): void {
  const diagnostics = `${stdout}\n${stderr}`;
  if (
    /font[^\n]*(?:substitut|not found|missing)|(?:substitut|not found|missing)[^\n]*font/i.test(
      diagnostics,
    )
  ) {
    throw new Error(`LibreOffice reported a font substitution warning: ${diagnostics.trim()}`);
  }
}

export function parsePdfPageCount(pdfInfoOutput: string): number {
  const pages = Number(/^Pages:\s*(\d+)\s*$/m.exec(pdfInfoOutput)?.[1]);
  if (!Number.isSafeInteger(pages) || pages <= 0) {
    throw new Error("Generated PDF has an invalid or zero page count");
  }
  return pages;
}

export function assertEmbeddedPdfFonts(pdfFontsOutput: string): void {
  const fontLines = pdfFontsOutput
    .split(/\r?\n/)
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean);
  if (fontLines.length === 0) throw new Error("Generated PDF has no inspectable embedded fonts");

  for (const line of fontLines) {
    const columns = line.split(/\s+/);
    const embedded = columns.at(-5);
    const subset = columns.at(-4);
    const unicodeMapped = columns.at(-3);
    if (embedded !== "yes" || subset !== "yes" || unicodeMapped !== "yes") {
      throw new Error(`Generated PDF font is not an embedded subset with a Unicode map: ${line}`);
    }
  }

  const normalized = fontLines.join(" ").replaceAll(/[ _-]/g, "").toLowerCase();
  if (!normalized.includes("ibmplexsans") || !normalized.includes("ibmplexmono")) {
    throw new Error(
      "Generated PDF does not embed both approved IBM Plex Sans and IBM Plex Mono fonts",
    );
  }
}

function replaceAsciiExactly(
  input: string,
  pattern: RegExp,
  replacement: string,
  expectedCount: number,
  label: string,
): string {
  let count = 0;
  const output = input.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  if (count !== expectedCount) {
    throw new Error(`Generated PDF has ${count} ${label} fields; expected ${expectedCount}`);
  }
  if (output.length !== input.length) {
    throw new Error(`PDF ${label} normalization changed byte length`);
  }
  return output;
}

interface ClassicXrefEntry {
  readonly offset: number;
  readonly generation: number;
  readonly status: "f" | "n";
}

interface ClassicXref {
  readonly offset: number;
  readonly entries: readonly ClassicXrefEntry[];
  readonly trailerBody: string;
}

interface BinaryReplacement {
  readonly start: number;
  readonly end: number;
  readonly bytes: Buffer;
}

function parseClassicXref(bytes: Buffer): ClassicXref {
  const text = bytes.toString("latin1");
  const startXref = /startxref\n(\d+)\n%%EOF\n?$/.exec(text);
  if (!startXref) throw new Error("Generated PDF does not have one terminal classic xref");
  const offset = Number(startXref[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= bytes.byteLength) {
    throw new Error("Generated PDF has an invalid classic xref offset");
  }
  const tail = text.slice(offset);
  const header = /^xref\n0 (\d+)\n/.exec(tail);
  if (!header) throw new Error("Generated PDF does not have a single-section classic xref");
  const count = Number(header[1]);
  if (!Number.isSafeInteger(count) || count <= 1) {
    throw new Error("Generated PDF classic xref has an invalid object count");
  }
  const trailerMarker = "trailer\n";
  const trailerIndex = tail.indexOf(trailerMarker, header[0].length);
  const startXrefIndex = tail.lastIndexOf("startxref\n");
  if (trailerIndex < 0 || startXrefIndex <= trailerIndex) {
    throw new Error("Generated PDF classic xref trailer is malformed");
  }
  const entryLines = tail.slice(header[0].length, trailerIndex).trimEnd().split("\n");
  if (entryLines.length !== count) {
    throw new Error(
      `Generated PDF classic xref has ${entryLines.length} entries; expected ${count}`,
    );
  }
  const entries = entryLines.map((line): ClassicXrefEntry => {
    const match = /^(\d{10}) (\d{5}) ([fn]) ?$/.exec(line);
    if (!match) throw new Error(`Generated PDF classic xref entry is malformed: ${line}`);
    return {
      offset: Number(match[1]),
      generation: Number(match[2]),
      status: match[3] as "f" | "n",
    };
  });
  return {
    offset,
    entries,
    trailerBody: tail.slice(trailerIndex + trailerMarker.length, startXrefIndex),
  };
}

function objectBounds(xref: ClassicXref, objectNumber: number): readonly [number, number] {
  const entry = xref.entries[objectNumber];
  if (!entry || entry.status !== "n" || entry.offset <= 0) {
    throw new Error(`Generated PDF xref is missing object ${objectNumber}`);
  }
  const laterOffsets = xref.entries
    .filter(({ status, offset }) => status === "n" && offset > entry.offset)
    .map(({ offset }) => offset);
  return [entry.offset, Math.min(xref.offset, ...laterOffsets)] as const;
}

function applyBinaryReplacements(
  prefix: Buffer,
  replacements: readonly BinaryReplacement[],
): Buffer {
  const sorted = [...replacements].sort((left, right) => left.start - right.start);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const replacement of sorted) {
    if (
      replacement.start < cursor ||
      replacement.end < replacement.start ||
      replacement.end > prefix.byteLength
    ) {
      throw new Error("Generated PDF normalization replacement is out of bounds or overlaps");
    }
    chunks.push(prefix.subarray(cursor, replacement.start), replacement.bytes);
    cursor = replacement.end;
  }
  chunks.push(prefix.subarray(cursor));
  return Buffer.concat(chunks);
}

function normalizeIccProfileTimestamp(bytes: Buffer, effectiveDate: string): Buffer {
  const text = bytes.toString("latin1");
  const outputProfiles = [...text.matchAll(/\/DestOutputProfile\s+(\d+)\s+0\s+R/g)];
  if (outputProfiles.length === 0) return bytes;
  const outputProfile = outputProfiles[0];
  if (outputProfiles.length !== 1 || !outputProfile?.[1]) {
    throw new Error(`Generated PDF has ${outputProfiles.length} output profiles; expected 1`);
  }

  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveDate);
  if (!date) throw new Error(`Invalid ICC profile normalization date: ${effectiveDate}`);
  const xref = parseClassicXref(bytes);
  const profileObjectNumber = Number(outputProfile[1]);
  const [profileStart, profileEnd] = objectBounds(xref, profileObjectNumber);
  const profileObject = bytes.subarray(profileStart, profileEnd);
  const profileHeader = profileObject.toString(
    "latin1",
    0,
    Math.min(profileObject.byteLength, 512),
  );
  const lengthReference = /\/Length\s+(\d+)\s+0\s+R/.exec(profileHeader)?.[1];
  if (!lengthReference || !/\/Filter\s*\/FlateDecode/.test(profileHeader)) {
    throw new Error("Generated PDF output profile is not one indirect FlateDecode stream");
  }
  const streamMarker = Buffer.from("stream\n");
  const streamMarkerOffset = profileObject.indexOf(streamMarker);
  const endStreamMarker = Buffer.from("\nendstream");
  const endStreamOffset = profileObject.indexOf(
    endStreamMarker,
    streamMarkerOffset + streamMarker.byteLength,
  );
  if (streamMarkerOffset < 0 || endStreamOffset < 0) {
    throw new Error("Generated PDF output profile stream is malformed");
  }
  const streamStart = profileStart + streamMarkerOffset + streamMarker.byteLength;
  const streamEnd = profileStart + endStreamOffset;
  let profile: Buffer;
  try {
    profile = Buffer.from(unzlibSync(bytes.subarray(streamStart, streamEnd)));
  } catch {
    throw new Error("Generated PDF output profile stream cannot be decompressed");
  }
  if (
    profile.byteLength < 128 ||
    profile.readUInt32BE(0) !== profile.byteLength ||
    profile.toString("ascii", 36, 40) !== "acsp"
  ) {
    throw new Error("Generated PDF output profile does not have a valid ICC header");
  }
  if (!profile.subarray(84, 100).every((value) => value === 0)) {
    throw new Error(
      "Generated PDF output profile has a non-zero profile ID that cannot be normalized",
    );
  }
  const [, year, month, day] = date;
  profile.writeUInt16BE(Number(year), 24);
  profile.writeUInt16BE(Number(month), 26);
  profile.writeUInt16BE(Number(day), 28);
  profile.fill(0, 30, 36);
  const compressedProfile = Buffer.from(zlibSync(profile, { level: 9 }));

  const lengthObjectNumber = Number(lengthReference);
  const [lengthStart, lengthEnd] = objectBounds(xref, lengthObjectNumber);
  const lengthObject = bytes.toString("latin1", lengthStart, lengthEnd);
  const lengthPattern = new RegExp(`^${lengthObjectNumber} 0 obj\\n(\\d+)\\nendobj\\n*$`);
  const lengthMatch = lengthPattern.exec(lengthObject);
  const oldLength = lengthMatch?.[1];
  if (!lengthMatch || lengthMatch.index !== 0 || !oldLength) {
    throw new Error("Generated PDF output profile length object is malformed");
  }
  if (Number(oldLength) !== streamEnd - streamStart) {
    throw new Error("Generated PDF output profile stream length does not match its length object");
  }
  const lengthValueOffset = lengthStart + lengthMatch[0].indexOf(oldLength);
  const replacements: readonly BinaryReplacement[] = [
    { start: streamStart, end: streamEnd, bytes: compressedProfile },
    {
      start: lengthValueOffset,
      end: lengthValueOffset + oldLength.length,
      bytes: Buffer.from(String(compressedProfile.byteLength)),
    },
  ];
  const updatedPrefix = applyBinaryReplacements(bytes.subarray(0, xref.offset), replacements);
  const shiftedOffset = (originalOffset: number): number =>
    originalOffset +
    replacements.reduce(
      (delta, replacement) =>
        replacement.end <= originalOffset
          ? delta + replacement.bytes.byteLength - (replacement.end - replacement.start)
          : delta,
      0,
    );
  const xrefEntries = xref.entries
    .map(({ offset, generation, status }) => {
      const updatedOffset = status === "n" ? shiftedOffset(offset) : offset;
      if (updatedOffset < 0 || updatedOffset > 9_999_999_999) {
        throw new Error("Generated PDF normalized xref offset exceeds the classic xref bound");
      }
      return `${String(updatedOffset).padStart(10, "0")} ${String(generation).padStart(5, "0")} ${status} `;
    })
    .join("\n");
  const updatedXref = Buffer.from(
    `xref\n0 ${xref.entries.length}\n${xrefEntries}\ntrailer\n${xref.trailerBody}startxref\n${updatedPrefix.byteLength}\n%%EOF\n`,
    "latin1",
  );
  return Buffer.concat([updatedPrefix, updatedXref]);
}

interface PdfObjectBody {
  readonly number: number;
  readonly body: Buffer;
}

interface EmbeddedFontGroup {
  readonly baseFont: string;
  readonly objectNumbers: readonly [number, number, number, number, number];
}

function readPdfObjectBody(bytes: Buffer, xref: ClassicXref, objectNumber: number): PdfObjectBody {
  const entry = xref.entries[objectNumber];
  if (!entry || entry.status !== "n" || entry.generation !== 0) {
    throw new Error(`Generated PDF object ${objectNumber} is not an in-use generation-zero object`);
  }
  const [start, end] = objectBounds(xref, objectNumber);
  const object = bytes.subarray(start, end);
  const header = Buffer.from(`${objectNumber} 0 obj\n`, "latin1");
  if (!object.subarray(0, header.byteLength).equals(header)) {
    throw new Error(`Generated PDF object ${objectNumber} header does not match its xref entry`);
  }
  const endObjectOffset = object.lastIndexOf(Buffer.from("\nendobj", "latin1"));
  if (endObjectOffset < header.byteLength) {
    throw new Error(`Generated PDF object ${objectNumber} has no terminal endobj marker`);
  }
  return { number: objectNumber, body: object.subarray(header.byteLength, endObjectOffset) };
}

function replaceMappedReferences(
  value: string,
  objectMapping: ReadonlyMap<number, number>,
): string {
  const isWhitespace = (character: string): boolean =>
    character === "\u0000" ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r" ||
    character === " ";
  const isDelimiter = (character: string): boolean =>
    character === "(" ||
    character === ")" ||
    character === "<" ||
    character === ">" ||
    character === "[" ||
    character === "]" ||
    character === "{" ||
    character === "}" ||
    character === "/" ||
    character === "%";
  const isBoundary = (character: string): boolean =>
    character === "" || isWhitespace(character) || isDelimiter(character);
  const protectedEnd = (start: number): number | undefined => {
    const opening = value.charAt(start);
    if (opening === "%") {
      let end = start + 1;
      while (end < value.length && !["\n", "\r"].includes(value.charAt(end))) end += 1;
      return end;
    }
    if (opening === "/") {
      let end = start + 1;
      while (
        end < value.length &&
        !isWhitespace(value.charAt(end)) &&
        !isDelimiter(value.charAt(end))
      ) {
        end += 1;
      }
      return end;
    }
    if (opening === "<" && value.charAt(start - 1) !== "<" && value.charAt(start + 1) !== "<") {
      const closing = value.indexOf(">", start + 1);
      if (closing < 0) throw new Error("Generated PDF has an unterminated hex string");
      return closing + 1;
    }
    if (opening !== "(") return undefined;
    let depth = 1;
    let end = start + 1;
    while (end < value.length) {
      const character = value.charAt(end);
      if (character === "\\") {
        end += value.charAt(end + 1) === "\r" && value.charAt(end + 2) === "\n" ? 3 : 2;
        continue;
      }
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) return end + 1;
      }
      end += 1;
    }
    throw new Error("Generated PDF has an unterminated literal string");
  };

  let rewritten = "";
  let index = 0;
  while (index < value.length) {
    const end = protectedEnd(index);
    if (end !== undefined) {
      rewritten += value.slice(index, end);
      index = end;
      continue;
    }

    const previous = index === 0 ? "" : value.charAt(index - 1);
    if (!/\d/.test(value.charAt(index)) || !isBoundary(previous)) {
      rewritten += value.charAt(index);
      index += 1;
      continue;
    }
    let objectEnd = index;
    while (/\d/.test(value.charAt(objectEnd))) objectEnd += 1;
    let generationStart = objectEnd;
    while (isWhitespace(value.charAt(generationStart))) generationStart += 1;
    if (generationStart === objectEnd || !/\d/.test(value.charAt(generationStart))) {
      rewritten += value.charAt(index);
      index += 1;
      continue;
    }
    let generationEnd = generationStart;
    while (/\d/.test(value.charAt(generationEnd))) generationEnd += 1;
    let referenceMarker = generationEnd;
    while (isWhitespace(value.charAt(referenceMarker))) referenceMarker += 1;
    if (
      referenceMarker === generationEnd ||
      value.charAt(referenceMarker) !== "R" ||
      !isBoundary(value.charAt(referenceMarker + 1))
    ) {
      rewritten += value.charAt(index);
      index += 1;
      continue;
    }
    const objectNumber = Number(value.slice(index, objectEnd));
    const generation = value.slice(generationStart, generationEnd);
    const mapped = generation === "0" ? objectMapping.get(objectNumber) : undefined;
    rewritten +=
      mapped === undefined
        ? value.slice(index, referenceMarker + 1)
        : `${mapped}${value.slice(objectEnd, generationStart)}0${value.slice(
            generationEnd,
            referenceMarker,
          )}R`;
    index = referenceMarker + 1;
  }
  return rewritten;
}

function rewritePdfObjectReferences(
  body: Buffer,
  objectMapping: ReadonlyMap<number, number>,
): Buffer {
  const streamMarker = Buffer.from("stream\n", "latin1");
  const streamOffset = body.indexOf(streamMarker);
  if (streamOffset < 0) {
    return Buffer.from(replaceMappedReferences(body.toString("latin1"), objectMapping), "latin1");
  }
  const streamStart = streamOffset + streamMarker.byteLength;
  const endStreamOffset = body.indexOf(Buffer.from("\nendstream", "latin1"), streamStart);
  if (endStreamOffset < 0) throw new Error("Generated PDF stream object has no endstream marker");
  const rewrittenHeader = Buffer.from(
    replaceMappedReferences(body.toString("latin1", 0, streamStart), objectMapping),
    "latin1",
  );
  const rewrittenSuffix = Buffer.from(
    replaceMappedReferences(body.toString("latin1", endStreamOffset), objectMapping),
    "latin1",
  );
  return Buffer.concat([
    rewrittenHeader,
    body.subarray(streamStart, endStreamOffset),
    rewrittenSuffix,
  ]);
}

function findEmbeddedFontGroups(bytes: Buffer, xref: ClassicXref): readonly EmbeddedFontGroup[] {
  const groups: EmbeddedFontGroup[] = [];
  for (let objectNumber = 1; objectNumber < xref.entries.length; objectNumber += 1) {
    const entry = xref.entries[objectNumber];
    if (!entry || entry.status !== "n") continue;
    const root = readPdfObjectBody(bytes, xref, objectNumber).body.toString("latin1");
    const baseFont = /\/Type\/Font\/Subtype\/TrueType\/BaseFont\/([A-Za-z0-9+_.-]+)/.exec(
      root,
    )?.[1];
    if (!baseFont || !baseFont.replaceAll(/[ _-]/g, "").includes("IBMPlex")) continue;
    const descriptorNumber = Number(/\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(root)?.[1]);
    const toUnicodeNumber = Number(/\/ToUnicode\s+(\d+)\s+0\s+R/.exec(root)?.[1]);
    if (!Number.isSafeInteger(descriptorNumber) || !Number.isSafeInteger(toUnicodeNumber)) {
      throw new Error(`Generated PDF IBM Plex font ${baseFont} has incomplete references`);
    }
    const descriptor = readPdfObjectBody(bytes, xref, descriptorNumber).body.toString("latin1");
    const fontFileNumber = Number(/\/FontFile2\s+(\d+)\s+0\s+R/.exec(descriptor)?.[1]);
    if (!Number.isSafeInteger(fontFileNumber)) {
      throw new Error(`Generated PDF IBM Plex font ${baseFont} has no FontFile2 reference`);
    }
    const fontFile = readPdfObjectBody(bytes, xref, fontFileNumber).body.toString("latin1", 0, 256);
    const lengthNumber = Number(/\/Length\s+(\d+)\s+0\s+R/.exec(fontFile)?.[1]);
    if (!Number.isSafeInteger(lengthNumber)) {
      throw new Error(`Generated PDF IBM Plex font ${baseFont} has no indirect stream length`);
    }
    const objectNumbers = [
      fontFileNumber,
      lengthNumber,
      descriptorNumber,
      toUnicodeNumber,
      objectNumber,
    ] as const;
    const sorted = [...objectNumbers].sort((left, right) => left - right);
    const firstObjectNumber = sorted[0];
    if (
      firstObjectNumber === undefined ||
      new Set(objectNumbers).size !== 5 ||
      sorted.some((value, index) => value !== firstObjectNumber + index) ||
      objectNumbers.some((value, index) => value !== sorted[index])
    ) {
      throw new Error(
        `Generated PDF IBM Plex font ${baseFont} is not one contiguous five-object group`,
      );
    }
    groups.push({ baseFont, objectNumbers });
  }
  const groupedObjects = groups.flatMap(({ objectNumbers }) => objectNumbers);
  if (new Set(groupedObjects).size !== groupedObjects.length) {
    throw new Error("Generated PDF IBM Plex font groups overlap");
  }
  return groups;
}

function canonicalizeEmbeddedFontGroups(bytes: Buffer): Buffer {
  if (!bytes.includes(Buffer.from("IBMPlex", "latin1"))) return bytes;
  const xref = parseClassicXref(bytes);
  const groups = findEmbeddedFontGroups(bytes, xref);
  if (groups.length < 2) return bytes;
  const targetGroups = [...groups].sort(
    (left, right) => left.objectNumbers[0] - right.objectNumbers[0],
  );
  const semanticGroups = [...groups].sort((left, right) =>
    left.baseFont.localeCompare(right.baseFont, "en"),
  );
  const objectMapping = new Map<number, number>();
  const sourceForTarget = new Map<number, number>();
  semanticGroups.forEach((source, groupIndex) => {
    const target = targetGroups[groupIndex];
    if (!target) throw new Error("Generated PDF font canonicalization lost a target group");
    source.objectNumbers.forEach((sourceNumber, objectIndex) => {
      const targetNumber = target.objectNumbers[objectIndex];
      if (targetNumber === undefined) {
        throw new Error("Generated PDF font canonicalization lost a target object");
      }
      objectMapping.set(sourceNumber, targetNumber);
      sourceForTarget.set(targetNumber, sourceNumber);
    });
  });

  const physicalObjects = xref.entries
    .map((entry, number) => ({ entry, number }))
    .filter(({ entry, number }) => number > 0 && entry.status === "n")
    .sort((left, right) => left.entry.offset - right.entry.offset);
  const firstObject = physicalObjects[0];
  if (!firstObject) throw new Error("Generated PDF has no in-use objects to canonicalize");
  const chunks: Buffer[] = [bytes.subarray(0, firstObject.entry.offset)];
  const updatedOffsets = new Map<number, number>();
  let outputOffset = chunks[0]?.byteLength ?? 0;
  for (const { number: targetNumber } of physicalObjects) {
    const sourceNumber = sourceForTarget.get(targetNumber) ?? targetNumber;
    const source = readPdfObjectBody(bytes, xref, sourceNumber);
    const canonicalNumber = objectMapping.get(source.number) ?? source.number;
    if (canonicalNumber !== targetNumber || updatedOffsets.has(canonicalNumber)) {
      throw new Error("Generated PDF font canonicalization produced a duplicate object number");
    }
    const body = rewritePdfObjectReferences(source.body, objectMapping);
    const serialized = Buffer.concat([
      Buffer.from(`${canonicalNumber} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n\n", "latin1"),
    ]);
    updatedOffsets.set(canonicalNumber, outputOffset);
    chunks.push(serialized);
    outputOffset += serialized.byteLength;
  }
  const updatedPrefix = Buffer.concat(chunks);
  const xrefEntries = xref.entries
    .map(({ offset, generation, status }, objectNumber) => {
      const updatedOffset = status === "n" ? updatedOffsets.get(objectNumber) : offset;
      if (updatedOffset === undefined || updatedOffset < 0 || updatedOffset > 9_999_999_999) {
        throw new Error(`Generated PDF canonical xref is missing object ${objectNumber}`);
      }
      return `${String(updatedOffset).padStart(10, "0")} ${String(generation).padStart(5, "0")} ${status} `;
    })
    .join("\n");
  const trailerBody = replaceMappedReferences(xref.trailerBody, objectMapping);
  const updatedXref = Buffer.from(
    `xref\n0 ${xref.entries.length}\n${xrefEntries}\ntrailer\n${trailerBody}startxref\n${updatedPrefix.byteLength}\n%%EOF\n`,
    "latin1",
  );
  return Buffer.concat([updatedPrefix, updatedXref]);
}

export function normalizeLibreOfficePdf(
  bytes: Uint8Array,
  effectiveDate: string,
  identity: string,
): Buffer {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveDate);
  if (!match) throw new Error(`Invalid PDF normalization date: ${effectiveDate}`);
  const [, year, month, day] = match;
  const xmpDate = `${effectiveDate}T00:00:00+00:00`;
  const pdfDate = `D:${year}${month}${day}000000+00'00'`;
  const iccNormalized = normalizeIccProfileTimestamp(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    effectiveDate,
  );
  let normalized = iccNormalized.toString("latin1");
  for (const field of ["CreateDate", "ModifyDate", "MetadataDate"] as const) {
    normalized = replaceAsciiExactly(
      normalized,
      new RegExp(`<xmp:${field}>[^<]{25}</xmp:${field}>`, "g"),
      `<xmp:${field}>${xmpDate}</xmp:${field}>`,
      1,
      `XMP ${field}`,
    );
  }
  normalized = replaceAsciiExactly(
    normalized,
    /<rdf:li>[^<]{25}<\/rdf:li>(?=\s*<\/rdf:Seq>\s*<\/dc:date>)/g,
    `<rdf:li>${xmpDate}</rdf:li>`,
    1,
    "XMP dc:date",
  );
  normalized = replaceAsciiExactly(
    normalized,
    /\/CreationDate\(D:\d{14}[+-]\d{2}'\d{2}'\)/g,
    `/CreationDate(${pdfDate})`,
    1,
    "PDF CreationDate",
  );

  const idMatches = [
    ...normalized.matchAll(/\/ID\s*\[\s*<([0-9A-Fa-f]{32})>\s*<([0-9A-Fa-f]{32})>\s*\]/g),
  ];
  const idMatch = idMatches[0];
  if (idMatches.length !== 1 || !idMatch || idMatch.index === undefined) {
    throw new Error(`Generated PDF has ${idMatches.length} trailer ID arrays; expected 1`);
  }
  const deterministicId = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  const matchedText = idMatch[0];
  const firstId = idMatch[1];
  const secondId = idMatch[2];
  if (!firstId || !secondId) throw new Error("Generated PDF trailer ID array is malformed");
  const firstOffset = matchedText.indexOf(firstId);
  const secondOffset = matchedText.indexOf(secondId, firstOffset + firstId.length);
  if (firstOffset < 0 || secondOffset < 0) throw new Error("Generated PDF trailer IDs are missing");
  const replacement =
    matchedText.slice(0, firstOffset) +
    deterministicId +
    matchedText.slice(firstOffset + firstId.length, secondOffset) +
    deterministicId +
    matchedText.slice(secondOffset + secondId.length);
  normalized =
    normalized.slice(0, idMatch.index) +
    replacement +
    normalized.slice(idMatch.index + matchedText.length);
  return canonicalizeEmbeddedFontGroups(Buffer.from(normalized, "latin1"));
}

function normalizeExtractedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/-\s+(?=[\p{L}\p{N}])/gu, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function assertExtractedPdfText(
  extractedText: string,
  requiredText: readonly string[],
): void {
  const normalized = normalizeExtractedText(extractedText);
  if (!normalized) throw new Error("Generated PDF has empty searchable text");
  if (!/[\u0400-\u04ff]/u.test(normalized)) {
    throw new Error("Generated PDF searchable text is missing Cyrillic");
  }
  for (const required of requiredText) {
    if (!normalized.includes(normalizeExtractedText(required))) {
      throw new Error(`Generated PDF is missing required text: ${required}`);
    }
  }
}

export function assertPdfNormalizationPreservesText(before: string, after: string): void {
  if (before !== after) {
    throw new Error("PDF normalization changed the complete searchable text");
  }
}

export function parseVeraPdfValidationResult(output: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("veraPDF did not return a machine-readable JSON result");
  }
  if (!isUnknownRecord(parsed) || !("report" in parsed)) {
    throw new Error("veraPDF machine-readable result is missing its report");
  }
  const report = parsed.report;
  if (!isUnknownRecord(report)) {
    throw new Error("veraPDF machine-readable result has an invalid report");
  }
  const jobsValue: unknown = report.jobs;
  const jobs: readonly unknown[] = Array.isArray(jobsValue)
    ? (jobsValue as readonly unknown[])
    : [];
  const summary: unknown = report.batchSummary;
  const firstJob: unknown = jobs[0];
  const validationResults: readonly unknown[] =
    isUnknownRecord(firstJob) && Array.isArray(firstJob.validationResult)
      ? (firstJob.validationResult as readonly unknown[])
      : [];
  const validationResult: unknown = validationResults[0];
  const validationDetails: unknown = isUnknownRecord(validationResult)
    ? validationResult.details
    : undefined;
  const validationSummary: unknown = isUnknownRecord(summary)
    ? summary.validationSummary
    : undefined;
  const featuresSummary: unknown = isUnknownRecord(summary) ? summary.featuresSummary : undefined;
  const repairSummary: unknown = isUnknownRecord(summary) ? summary.repairSummary : undefined;
  const conformant =
    jobs.length === 1 &&
    validationResults.length === 1 &&
    isUnknownRecord(validationResult) &&
    validationResult.compliant === true &&
    validationResult.jobEndStatus === "normal" &&
    validationResult.profileName === "PDF/A-2b validation profile" &&
    isUnknownRecord(validationDetails) &&
    validationDetails.failedRules === 0 &&
    validationDetails.failedChecks === 0;
  const summaryConformant =
    isUnknownRecord(summary) &&
    summary.totalJobs === 1 &&
    summary.outOfMemory === 0 &&
    summary.veraExceptions === 0 &&
    summary.multiJob === false &&
    summary.failedEncryptedJobs === 0 &&
    summary.failedParsingJobs === 0 &&
    isUnknownRecord(featuresSummary) &&
    featuresSummary.failedJobCount === 0 &&
    featuresSummary.totalJobCount === 0 &&
    featuresSummary.successfulJobCount === 0 &&
    isUnknownRecord(repairSummary) &&
    repairSummary.failedJobCount === 0 &&
    repairSummary.totalJobCount === 0 &&
    repairSummary.successfulJobCount === 0 &&
    isUnknownRecord(validationSummary) &&
    validationSummary.totalJobCount === 1 &&
    validationSummary.successfulJobCount === 1 &&
    validationSummary.failedJobCount === 0 &&
    validationSummary.compliantPdfaCount === 1 &&
    validationSummary.nonCompliantPdfaCount === 0;
  if (!conformant || !summaryConformant) {
    throw new Error("Generated PDF is not conformant with PDF/A-2b according to veraPDF");
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockText(block: LegalBlock): string {
  switch (block.kind) {
    case "paragraph":
      return block.text;
    case "ordered-list":
    case "unordered-list":
      return block.items.join(" ");
    case "definition-list":
      return block.items.map(({ term, detail }) => `${term}. ${detail}`).join(" ");
  }
}

function requiredPdfText(request: LegalArtifactRequest): readonly string[] {
  const source = findLegalDocument(request.code, request.revision).content[request.locale];
  const release = LEGAL_RELEASES.find(
    ({ code, revision }) => code === request.code && revision === request.revision,
  );
  if (!release) throw new Error(`Missing release for PDF validation: ${request.code}`);
  const firstSection = source.sections[0];
  const lastSection = source.sections.at(-1);
  const firstBlock = firstSection?.blocks[0];
  const lastBlock = lastSection?.blocks.at(-1);
  if (!firstSection || !lastSection || !firstBlock || !lastBlock) {
    throw new Error(
      `Legal document has no boundary section text: ${request.code}/${request.locale}`,
    );
  }
  return [
    source.title,
    request.code,
    request.revision,
    OPERATOR_PROFILES[release.operatorProfileId].name,
    firstSection.heading,
    blockText(firstBlock),
    lastSection.heading,
    blockText(lastBlock),
  ];
}

async function runTextCommand(
  binary: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): Promise<ConversionResult> {
  const result = await execFile(binary, [...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...(environment ? { env: environment } : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function requireContainerRuntime(): string {
  const runtime = process.env.VERAPDF_CONTAINER_RUNTIME;
  if (!runtime || (path.basename(runtime) !== "docker" && path.basename(runtime) !== "podman")) {
    throw new Error("VERAPDF_CONTAINER_RUNTIME must explicitly name docker or podman");
  }
  return runtime;
}

function createDefaultDependencies(): ArtifactGenerationDependencies {
  let veraPdfVersionCheck: Promise<void> | undefined;
  const ensureVeraPdfVersion = (): Promise<void> => {
    veraPdfVersionCheck ??= (async () => {
      const result = await runTextCommand(requireContainerRuntime(), [
        "run",
        "--rm",
        "--network",
        "none",
        VERAPDF_RELEASE_IMAGE,
        "--version",
      ]);
      if (
        !new RegExp(`(?:^|\\D)${VERAPDF_VERSION.replaceAll(".", "\\.")}(?:\\D|$)`).test(
          result.stdout,
        )
      ) {
        throw new Error(`Release generation requires veraPDF ${VERAPDF_VERSION}: ${result.stdout}`);
      }
    })();
    return veraPdfVersionCheck;
  };

  return {
    getLibreOfficeVersion: async (sofficeBin) =>
      (await runTextCommand(sofficeBin, ["--version"])).stdout,
    renderDocx: renderLegalDocx,
    convertPdf: async ({ sofficeBin, sourcePath, outputDirectory }) => {
      const profileDirectory = libreOfficeProfileDirectory(outputDirectory, sourcePath);
      await mkdir(profileDirectory, { recursive: true });
      await Promise.all([
        mkdir(path.join(profileDirectory, "xdg-cache"), { recursive: true }),
        mkdir(path.join(profileDirectory, "xdg-config"), { recursive: true }),
      ]);
      return runTextCommand(
        sofficeBin,
        libreOfficePdfExportArguments(outputDirectory, sourcePath),
        libreOfficeEnvironment(profileDirectory),
      );
    },
    extractPdfText: async (pdfPath) =>
      runTextCommand("pdftotext", ["-raw", "-enc", "UTF-8", pdfPath, "-"]),
    validatePdf: async ({ pdfPath, request, conversion, extractedText }) => {
      assertNoFontSubstitutionWarnings(conversion.stdout, conversion.stderr);
      const pdfStats = await stat(pdfPath);
      if (!pdfStats.isFile() || pdfStats.size <= 0)
        throw new Error(`Generated PDF is empty: ${pdfPath}`);
      if (pdfStats.size > MAX_LEGAL_PDF_BYTES) {
        throw new Error(`Generated PDF exceeds the five MiB release bound: ${pdfPath}`);
      }

      const pdfInfo = await runTextCommand("pdfinfo", [pdfPath]);
      assertNoFontSubstitutionWarnings(pdfInfo.stdout, pdfInfo.stderr);
      parsePdfPageCount(pdfInfo.stdout);
      const pdfFonts = await runTextCommand("pdffonts", [pdfPath]);
      assertNoFontSubstitutionWarnings(pdfFonts.stdout, pdfFonts.stderr);
      assertEmbeddedPdfFonts(pdfFonts.stdout);
      assertExtractedPdfText(extractedText, requiredPdfText(request));

      await ensureVeraPdfVersion();
      const artifactDirectory = path.dirname(pdfPath);
      const veraPdf = await runTextCommand(requireContainerRuntime(), [
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${artifactDirectory}:/data:ro`,
        VERAPDF_RELEASE_IMAGE,
        "--format",
        "json",
        "--flavour",
        "2b",
        `/data/${path.basename(pdfPath)}`,
      ]);
      parseVeraPdfValidationResult(veraPdf.stdout);
    },
  };
}

function currentRequests(): readonly LegalArtifactRequest[] {
  return LEGAL_RELEASES.filter(({ status }) => status === "active").flatMap((release) =>
    (["ru", "en"] as const).flatMap((locale) => [
      {
        code: release.code,
        revision: release.revision,
        effectiveDate: release.effectiveDate,
        locale,
        kind: "legal-pdf" as const,
        verificationUrl: legalVerificationUrl(release),
      },
      ...(TEMPLATE_CODES.has(release.code)
        ? [
            {
              code: release.code,
              revision: release.revision,
              effectiveDate: release.effectiveDate,
              locale,
              kind: "template-docx" as const,
              verificationUrl: legalVerificationUrl(release),
            },
          ]
        : []),
    ]),
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertNoSymlink(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new Error(`Refusing to follow symbolic link: ${filePath}`);
}

async function assertNoSymlinkAncestors(allowedRoot: string, candidatePath: string): Promise<void> {
  const root = path.resolve(allowedRoot);
  const candidate = path.resolve(candidatePath);
  if (!pathIsInside(root, candidate)) {
    throw new Error(`Artifact path is outside its allowed root: ${candidate}`);
  }
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Refusing symbolic-link ancestor for artifact output: ${root}`);
  }
  const canonicalRoot = await realpath(root);
  const relative = path.relative(root, candidate);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let currentInfo;
    try {
      currentInfo = await lstat(current);
    } catch (error) {
      if (errorHasCode(error, "ENOENT")) return;
      throw error;
    }
    if (currentInfo.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link ancestor for artifact output: ${current}`);
    }
    const canonicalCurrent = await realpath(current);
    if (!pathIsInside(canonicalRoot, canonicalCurrent)) {
      throw new Error(`Refusing symbolic-link ancestor for artifact output: ${current}`);
    }
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const GENERATION_LOCK_NAME = ".markiro-legal-artifacts.lock";
const GENERATION_OWNER_PREFIX = ".markiro-legal-artifacts.owner-";
const GENERATION_TOKEN = /^[0-9a-f]{32}$/;

interface GenerationLockOwner {
  readonly version: 1;
  readonly token: string;
  readonly processId: number;
  readonly outDir: string;
  readonly temporaryRoot: string;
  readonly temporaryDevice: number;
  readonly temporaryInode: number;
}

interface OwnedGenerationLock {
  readonly owner: GenerationLockOwner;
  readonly ownerPath: string;
  readonly device: number;
  readonly inode: number;
}

export function artifactGenerationLockPath(repositoryRoot: string): string {
  return path.join(path.resolve(repositoryRoot), GENERATION_LOCK_NAME);
}

function generationOwnerPath(repositoryRoot: string, token: string): string {
  return path.join(path.resolve(repositoryRoot), `${GENERATION_OWNER_PREFIX}${token}.json`);
}

function canonicalGenerationLockOwner(owner: GenerationLockOwner): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

function parseGenerationLockOwner(value: unknown): GenerationLockOwner | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const expectedKeys = [
    "outDir",
    "processId",
    "temporaryDevice",
    "temporaryInode",
    "temporaryRoot",
    "token",
    "version",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index]) ||
    value.version !== 1 ||
    typeof value.token !== "string" ||
    !GENERATION_TOKEN.test(value.token) ||
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    typeof value.outDir !== "string" ||
    path.resolve(value.outDir) !== value.outDir ||
    typeof value.temporaryRoot !== "string" ||
    path.resolve(value.temporaryRoot) !== value.temporaryRoot ||
    !Number.isSafeInteger(value.temporaryDevice) ||
    !Number.isSafeInteger(value.temporaryInode)
  ) {
    return undefined;
  }
  return {
    version: 1,
    token: value.token,
    processId: value.processId as number,
    outDir: value.outDir,
    temporaryRoot: value.temporaryRoot,
    temporaryDevice: value.temporaryDevice as number,
    temporaryInode: value.temporaryInode as number,
  };
}

function isSafeOwnedTemporaryRoot(owner: GenerationLockOwner, repositoryRoot: string): boolean {
  if (!path.basename(owner.temporaryRoot).startsWith(".markiro-legal-build-")) return false;
  return (
    pathIsInside(path.resolve(repositoryRoot), owner.temporaryRoot) ||
    path.dirname(owner.temporaryRoot) === path.dirname(owner.outDir)
  );
}

function foreignGenerationLockError(lockPath: string, cause?: unknown): Error {
  return new Error(`Refusing foreign or malformed legal artifact generation lock: ${lockPath}`, {
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readOwnedGenerationLock(
  repositoryRoot: string,
  lockPath: string,
): Promise<OwnedGenerationLock> {
  let lockInfo;
  try {
    lockInfo = await lstat(lockPath);
  } catch (error) {
    throw foreignGenerationLockError(lockPath, error);
  }
  if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) {
    throw foreignGenerationLockError(lockPath);
  }
  let owner: GenerationLockOwner | undefined;
  try {
    owner = parseGenerationLockOwner(JSON.parse(await readFile(lockPath, "utf8")));
  } catch (error) {
    throw foreignGenerationLockError(lockPath, error);
  }
  if (!owner || !isSafeOwnedTemporaryRoot(owner, repositoryRoot)) {
    throw foreignGenerationLockError(lockPath);
  }
  const ownerPath = generationOwnerPath(repositoryRoot, owner.token);
  let ownerInfo;
  let lockAfterRead;
  try {
    [ownerInfo, lockAfterRead] = await Promise.all([lstat(ownerPath), lstat(lockPath)]);
  } catch (error) {
    throw foreignGenerationLockError(lockPath, error);
  }
  if (
    !ownerInfo.isFile() ||
    ownerInfo.isSymbolicLink() ||
    ownerInfo.dev !== lockInfo.dev ||
    ownerInfo.ino !== lockInfo.ino ||
    lockAfterRead.dev !== lockInfo.dev ||
    lockAfterRead.ino !== lockInfo.ino
  ) {
    throw foreignGenerationLockError(lockPath);
  }
  return { owner, ownerPath, device: lockInfo.dev, inode: lockInfo.ino };
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !errorHasCode(error, "ESRCH");
  }
}

async function assertOwnedLockIdentity(
  lockPath: string,
  owned: OwnedGenerationLock,
): Promise<void> {
  const [lockInfo, ownerInfo] = await Promise.all([lstat(lockPath), lstat(owned.ownerPath)]);
  if (
    !lockInfo.isFile() ||
    lockInfo.isSymbolicLink() ||
    lockInfo.dev !== owned.device ||
    lockInfo.ino !== owned.inode ||
    ownerInfo.dev !== owned.device ||
    ownerInfo.ino !== owned.inode
  ) {
    throw new Error(`Legal artifact generation lock identity changed: ${lockPath}`);
  }
}

async function recoverStaleGenerationLock(
  repositoryRoot: string,
  lockPath: string,
  owned: OwnedGenerationLock,
): Promise<void> {
  try {
    const temporaryInfo = await lstat(owned.owner.temporaryRoot);
    if (
      !temporaryInfo.isDirectory() ||
      temporaryInfo.isSymbolicLink() ||
      temporaryInfo.dev !== owned.owner.temporaryDevice ||
      temporaryInfo.ino !== owned.owner.temporaryInode
    ) {
      throw new Error(
        `Stale legal artifact staging path is no longer owned: ${owned.owner.temporaryRoot}`,
      );
    }
    await rm(owned.owner.temporaryRoot, { recursive: true });
  } catch (error) {
    if (!errorHasCode(error, "ENOENT")) throw error;
  }
  await assertOwnedLockIdentity(lockPath, owned);
  await unlink(lockPath);
  await unlink(owned.ownerPath);
  await syncDirectory(path.resolve(repositoryRoot));
}

export async function acquireArtifactGenerationLock(
  options: AcquireArtifactGenerationLockOptions,
): Promise<ArtifactGenerationLock> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const outDir = path.resolve(options.outDir);
  const temporaryRoot = path.resolve(options.temporaryRoot);
  const processId = options.processId ?? process.pid;
  const token = options.token ?? randomBytes(16).toString("hex");
  if (!Number.isSafeInteger(processId) || processId <= 0 || !GENERATION_TOKEN.test(token)) {
    throw new Error("Legal artifact generation lock owner identity is invalid");
  }
  const repositoryInfo = await lstat(repositoryRoot);
  const temporaryInfo = await lstat(temporaryRoot);
  if (
    !repositoryInfo.isDirectory() ||
    repositoryInfo.isSymbolicLink() ||
    !temporaryInfo.isDirectory() ||
    temporaryInfo.isSymbolicLink()
  ) {
    throw new Error("Legal artifact generation lock paths must be ordinary directories");
  }
  const owner: GenerationLockOwner = {
    version: 1,
    token,
    processId,
    outDir,
    temporaryRoot,
    temporaryDevice: temporaryInfo.dev,
    temporaryInode: temporaryInfo.ino,
  };
  if (!isSafeOwnedTemporaryRoot(owner, repositoryRoot)) {
    throw new Error(`Legal artifact staging path is outside an allowed root: ${temporaryRoot}`);
  }
  const lockPath = artifactGenerationLockPath(repositoryRoot);
  const ownerPath = generationOwnerPath(repositoryRoot, token);
  await writeFile(ownerPath, canonicalGenerationLockOwner(owner), { flag: "wx", mode: 0o600 });
  await syncFile(ownerPath);

  let acquired: OwnedGenerationLock | undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(ownerPath, lockPath);
        const lockInfo = await lstat(lockPath);
        acquired = { owner, ownerPath, device: lockInfo.dev, inode: lockInfo.ino };
        await syncDirectory(repositoryRoot);
        break;
      } catch (error) {
        if (!errorHasCode(error, "EEXIST")) throw error;
        const existing = await readOwnedGenerationLock(repositoryRoot, lockPath);
        const isAlive = options.isProcessAlive ?? processIsAlive;
        if (isAlive(existing.owner.processId)) {
          throw new Error(
            `Refusing live legal artifact generation lock owned by process ${existing.owner.processId}`,
            { cause: error },
          );
        }
        await recoverStaleGenerationLock(repositoryRoot, lockPath, existing);
      }
    }
    if (!acquired) throw new Error("Could not acquire the legal artifact generation lock");
  } catch (error) {
    try {
      await unlink(ownerPath);
    } catch (cleanupError) {
      if (!errorHasCode(cleanupError, "ENOENT")) {
        throw new AggregateError(
          [error, cleanupError],
          "Legal artifact generation lock acquisition and owner cleanup both failed",
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released || !acquired) return;
      await assertOwnedLockIdentity(lockPath, acquired);
      await unlink(lockPath);
      await unlink(ownerPath);
      await syncDirectory(repositoryRoot);
      released = true;
    },
  };
}

async function compareReleaseDirectories(expectedRoot: string, actualRoot: string): Promise<void> {
  const expectedRootEntries = (await readdir(expectedRoot)).sort();
  const actualRootEntries = (await readdir(actualRoot)).sort();
  if (JSON.stringify(expectedRootEntries) !== JSON.stringify(actualRootEntries)) {
    throw new Error("Existing release is not byte-identical to generated output");
  }
  for (const rootEntry of expectedRootEntries) {
    const expectedPath = path.join(expectedRoot, rootEntry);
    const actualPath = path.join(actualRoot, rootEntry);
    await assertNoSymlink(actualPath);
    const expectedInfo = await lstat(expectedPath);
    const actualInfo = await lstat(actualPath);
    if (expectedInfo.isDirectory() !== actualInfo.isDirectory()) {
      throw new Error("Existing release is not byte-identical to generated output");
    }
    if (expectedInfo.isDirectory()) {
      const expectedFiles = (await readdir(expectedPath)).sort();
      const actualFiles = (await readdir(actualPath)).sort();
      if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
        throw new Error("Existing release is not byte-identical to generated output");
      }
      for (const fileName of expectedFiles) {
        const expectedFile = path.join(expectedPath, fileName);
        const actualFile = path.join(actualPath, fileName);
        await assertNoSymlink(actualFile);
        const [expectedBytes, actualBytes] = await Promise.all([
          readFile(expectedFile),
          readFile(actualFile),
        ]);
        if (!expectedBytes.equals(actualBytes)) {
          throw new Error(`Existing release is not byte-identical: ${fileName}`);
        }
      }
    } else {
      const [expectedBytes, actualBytes] = await Promise.all([
        readFile(expectedPath),
        readFile(actualPath),
      ]);
      if (!expectedBytes.equals(actualBytes)) {
        throw new Error(`Existing release is not byte-identical: ${rootEntry}`);
      }
    }
  }
}

async function writeGeneratedArtifacts(
  releaseRoot: string,
  internalRoot: string,
  options: ArtifactGenerationOptions,
  dependencies: ArtifactGenerationDependencies,
): Promise<PublishedLegalArtifact[]> {
  const filesRoot = path.join(releaseRoot, "files");
  await mkdir(filesRoot);
  await mkdir(internalRoot);
  const entries: PublishedLegalArtifact[] = [];
  const pdfaValidatedFiles = new Set<string>();

  for (const request of currentRequests()) {
    const fileName = artifactFileName(request);
    const docxBytes = await dependencies.renderDocx(request);
    if (request.kind === "template-docx") {
      const outputPath = path.join(filesRoot, fileName);
      await writeFile(outputPath, docxBytes, { flag: "wx" });
      entries.push({
        code: request.code,
        revision: request.revision,
        effectiveDate: request.effectiveDate,
        locale: request.locale,
        kind: "template-docx",
        fileName,
        bytes: docxBytes.byteLength,
        sha256: createHash("sha256").update(docxBytes).digest("hex"),
        mediaType: DOCX_MEDIA_TYPE,
        generator: { docx: "9.7.1" },
      });
      continue;
    }

    const sourcePath = path.join(internalRoot, fileName.replace(/\.pdf$/, ".docx"));
    await writeFile(sourcePath, docxBytes, { flag: "wx" });
    const conversion = await dependencies.convertPdf({
      sofficeBin: options.sofficeBin,
      sourcePath,
      outputDirectory: filesRoot,
    });
    const outputPath = path.join(filesRoot, fileName);
    await assertNoSymlink(outputPath);
    if (!options.preview) {
      const extractedBefore = await dependencies.extractPdfText(outputPath);
      assertNoFontSubstitutionWarnings(extractedBefore.stdout, extractedBefore.stderr);
      const normalizedPdf = normalizeLibreOfficePdf(
        await readFile(outputPath),
        request.effectiveDate,
        fileName,
      );
      await writeFile(outputPath, normalizedPdf);
      const extractedAfter = await dependencies.extractPdfText(outputPath);
      assertNoFontSubstitutionWarnings(extractedAfter.stdout, extractedAfter.stderr);
      assertPdfNormalizationPreservesText(extractedBefore.stdout, extractedAfter.stdout);
      await dependencies.validatePdf({
        pdfPath: outputPath,
        request,
        conversion,
        extractedText: extractedAfter.stdout,
      });
      pdfaValidatedFiles.add(fileName);
    }
    const bytes = await readFile(outputPath);
    if (!options.preview) {
      entries.push({
        code: request.code,
        revision: request.revision,
        effectiveDate: request.effectiveDate,
        locale: request.locale,
        kind: "pdfa-2b",
        fileName,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mediaType: "application/pdf",
        generator: { docx: "9.7.1", libreOffice: "26.2.5", veraPdf: "1.30.2" },
      });
    }
  }

  if (options.preview) {
    await writeFile(
      path.join(releaseRoot, "PREVIEW-NOT-FOR-RELEASE.txt"),
      "Development preview only. This directory has no release manifest and no PDF/A claim.\n",
      { flag: "wx" },
    );
    return [];
  }

  const manifestPath = path.join(releaseRoot, "artifacts.json");
  await writeFile(manifestPath, canonicalArtifactManifest(entries), { flag: "wx" });
  const verified = await verifyArtifactManifest({
    rootDir: releaseRoot,
    manifestPath,
    pdfaValidatedFiles,
  });
  await Promise.all([
    ...verified.map(async ({ fileName }) => syncFile(path.join(filesRoot, fileName))),
    syncFile(manifestPath),
  ]);
  await syncDirectory(filesRoot);
  await syncDirectory(releaseRoot);
  return verified;
}

export async function generateLegalArtifacts(
  rawOptions: ArtifactGenerationOptions,
  dependencies: ArtifactGenerationDependencies = createDefaultDependencies(),
): Promise<PublishedLegalArtifact[]> {
  const options = {
    ...rawOptions,
    repositoryRoot: path.resolve(rawOptions.repositoryRoot),
    outDir: resolveGenerationOutput(
      rawOptions.outDir,
      rawOptions.repositoryRoot,
      rawOptions.preview,
    ),
    sofficeBin: path.resolve(rawOptions.sofficeBin),
  };
  if (options.preview && options.check)
    throw new Error("Preview generation does not support --check");

  const allowedOutputRoot = pathIsInside(options.repositoryRoot, options.outDir)
    ? options.repositoryRoot
    : path.parse(options.outDir).root;
  await assertNoSymlinkAncestors(allowedOutputRoot, options.outDir);

  const outputParent = path.dirname(options.outDir);
  await mkdir(outputParent, { recursive: true });
  await assertNoSymlinkAncestors(allowedOutputRoot, outputParent);
  const temporaryParent = options.preview ? outputParent : options.repositoryRoot;
  const temporaryRoot = await mkdtemp(path.join(temporaryParent, ".markiro-legal-build-"));
  await assertNoSymlinkAncestors(temporaryParent, temporaryRoot);
  const releaseRoot = path.join(temporaryRoot, "release");
  const internalRoot = path.join(temporaryRoot, "internal");
  await mkdir(releaseRoot);
  let generationLock: ArtifactGenerationLock | undefined;
  const cleanup = async (): Promise<void> => {
    const cleanupErrors: unknown[] = [];
    try {
      await rm(temporaryRoot, { recursive: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (generationLock) {
      try {
        await generationLock.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Legal artifact generation cleanup failed");
    }
  };
  const runGeneration = async (): Promise<PublishedLegalArtifact[]> => {
    generationLock = await acquireArtifactGenerationLock({
      repositoryRoot: options.repositoryRoot,
      outDir: options.outDir,
      temporaryRoot,
    });
    const outputExists = await exists(options.outDir);
    if (outputExists) {
      await assertNoSymlink(options.outDir);
      if (!options.check)
        throw new Error(`Immutable legal artifact release already exists: ${options.outDir}`);
    } else if (options.check) {
      throw new Error(`Cannot --check a missing legal artifact release: ${options.outDir}`);
    }

    const version = await dependencies.getLibreOfficeVersion(options.sofficeBin);
    assertReleaseLibreOfficeVersion(version, options.preview);
    const entries = await writeGeneratedArtifacts(releaseRoot, internalRoot, options, dependencies);
    if (outputExists) {
      await compareReleaseDirectories(releaseRoot, options.outDir);
      if (!options.preview) {
        await verifyArtifactManifest({
          rootDir: options.outDir,
          manifestPath: path.join(options.outDir, "artifacts.json"),
          pdfaValidatedFiles: new Set(
            entries.filter(({ kind }) => kind === "pdfa-2b").map(({ fileName }) => fileName),
          ),
        });
      }
      return entries;
    }
    await dependencies.beforePublish?.(options.outDir);
    await assertNoSymlinkAncestors(allowedOutputRoot, options.outDir);
    if (await exists(options.outDir)) {
      await assertNoSymlink(options.outDir);
      throw new Error(`Immutable legal artifact release already exists: ${options.outDir}`);
    }
    const [releaseInfo, outputParentInfo] = await Promise.all([
      stat(releaseRoot),
      stat(outputParent),
    ]);
    if (releaseInfo.dev !== outputParentInfo.dev) {
      throw new Error("Atomic legal artifact publication requires staging on one filesystem");
    }
    // The external lock serializes cooperating generators, and the immediately preceding
    // destination check prevents replacement of any observed release. Node exposes no portable
    // atomic rename-without-replace primitive; a non-cooperating process can still race this
    // check on platforms whose rename replaces an empty directory.
    await rename(releaseRoot, options.outDir);
    await Promise.all([syncDirectory(temporaryRoot), syncDirectory(outputParent)]);
    return entries;
  };

  let entries: PublishedLegalArtifact[];
  try {
    entries = await runGeneration();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Legal artifact generation and cleanup both failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  await cleanup();
  return entries;
}

function defaultRepositoryRoot(): string {
  return fileURLToPath(new URL("../../../..", import.meta.url));
}

function parseCliArguments(
  args: readonly string[],
): Omit<ArtifactGenerationOptions, "repositoryRoot"> {
  let outDir: string | undefined;
  let preview = false;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--out-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--out-dir requires a value");
      if (outDir) throw new Error("--out-dir may be supplied only once");
      outDir = value;
      index += 1;
    } else if (argument === "--preview") {
      preview = true;
    } else if (argument === "--check") {
      check = true;
    } else {
      throw new Error(`Unknown artifact generation argument: ${String(argument)}`);
    }
  }
  if (!outDir) throw new Error("Artifact generation requires explicit --out-dir");
  const sofficeBin = process.env.SOFFICE_BIN;
  if (!sofficeBin) throw new Error("Artifact generation requires explicit SOFFICE_BIN");
  return { outDir, preview, check, sofficeBin };
}

async function main(): Promise<void> {
  const repositoryRoot = defaultRepositoryRoot();
  const options = parseCliArguments(process.argv.slice(2));
  const entries = await generateLegalArtifacts({ ...options, repositoryRoot });
  process.stdout.write(
    options.preview
      ? `Generated a non-release preview at ${path.resolve(options.outDir)}\n`
      : `Validated ${entries.length} immutable legal artifacts at ${path.resolve(options.outDir)}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
