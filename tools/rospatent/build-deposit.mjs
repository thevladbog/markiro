#!/usr/bin/env node
// Builds the Rospatent deposit listing (депонируемые материалы) for the
// computer-program registration: a PDF with a title page, contents and
// numbered fragments of the repository's own source files, chosen by
// docs/registration/rospatent/deposit-manifest.json.
//
//   node tools/rospatent/build-deposit.mjs [--manifest <path>] [--out <dir>] [--date <ISO>]
//
// The tool is hermetic: it embeds the vendored IBM Plex Mono fonts from
// packages/legal-documents/fonts and needs no LibreOffice or npm packages.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LAYOUT,
  buildAbstractPage,
  extractAbstract,
  layoutDocument,
  selectFragment,
} from "./listing.mjs";
import { A4, PdfDocument, parseTrueTypeFont } from "./pdf.mjs";

const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(TOOL_ROOT, "../..");
const FONT_ROOT = path.join(REPOSITORY_ROOT, "packages/legal-documents/fonts");
const DEFAULT_MANIFEST = "docs/registration/rospatent/deposit-manifest.json";
const DEFAULT_OUT = "docs/registration/rospatent/build";
const DEFAULT_ABSTRACT = "docs/registration/rospatent/abstract.md";
const ABSTRACT_EDITION = "Основная редакция";
const ABSTRACT_COLUMNS = 80;

const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".rs", ".kt", ".sql", ".mjs", ".astro", ".css"]);
const FORBIDDEN_SEGMENTS = new Set(["node_modules", "dist", "target", "build", ".git"]);
const FORBIDDEN_NAME = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx))$/u;

const GEOMETRY = Object.freeze({
  left: 40,
  bodySize: 9,
  bodyLeading: 10.6,
  headerSize: 8,
  headerBaseline: A4.height - 32,
  ruleY: A4.height - 38,
  firstBaseline: A4.height - 52,
  footerBaseline: 30,
});

export function parseArguments(argv) {
  const options = { manifest: DEFAULT_MANIFEST, out: DEFAULT_OUT, date: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--manifest" && value) options.manifest = value;
    else if (argument === "--out" && value) options.out = value;
    else if (argument === "--date" && value) options.date = value;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (options.date !== null && Number.isNaN(Date.parse(options.date))) {
    throw new Error(`--date must be an ISO 8601 timestamp, got ${options.date}`);
  }
  return options;
}

export function validateManifest(manifest) {
  const requiredStrings = ["title", "holder", "version"];
  for (const key of requiredStrings) {
    if (typeof manifest[key] !== "string" || manifest[key].trim() === "") {
      throw new Error(`manifest.${key} must be a non-empty string`);
    }
  }
  for (const key of ["authors", "languages"]) {
    if (!Array.isArray(manifest[key]) || manifest[key].length === 0) {
      throw new Error(`manifest.${key} must be a non-empty array`);
    }
  }
  if (!Number.isInteger(manifest.maxPages) || manifest.maxPages < 1) {
    throw new Error("manifest.maxPages must be a positive integer");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("manifest.files must list at least one file");
  }
  if (manifest.abstract !== undefined) {
    if (typeof manifest.abstract !== "string" || !manifest.abstract.endsWith(".md")) {
      throw new Error("manifest.abstract must point at a Markdown file");
    }
    if (path.isAbsolute(manifest.abstract) || manifest.abstract.split("/").includes("..")) {
      throw new Error("manifest.abstract must stay inside the repository");
    }
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== "string") throw new Error("every manifest file needs a path");
    assertDepositablePath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate manifest entry: ${file.path}`);
    seen.add(file.path);
  }
  return manifest;
}

export function assertDepositablePath(relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error(`manifest paths must stay inside the repository: ${relativePath}`);
  }
  if (relativePath.split("/").some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new Error(`generated or vendored code cannot be deposited: ${relativePath}`);
  }
  if (FORBIDDEN_NAME.test(relativePath)) {
    throw new Error(`secret-bearing files cannot be deposited: ${relativePath}`);
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(relativePath))) {
    throw new Error(`unsupported source file type: ${relativePath}`);
  }
}

function describeSourceState(root) {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const date = execFileSync("git", ["log", "-1", "--format=%cs"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    return { sha, date, label: `git ${sha} от ${date}` };
  } catch {
    return { sha: null, date: null, label: "рабочая копия без сведений git" };
  }
}

async function loadEntries(manifest, root) {
  const entries = [];
  for (const file of manifest.files) {
    const source = await readFile(path.join(root, file.path), "utf8");
    const fragment = selectFragment(source, { lines: file.lines, maxLines: file.maxLines });
    entries.push({
      path: file.path,
      comment: file.comment,
      sha256: createHash("sha256").update(source).digest("hex"),
      ...fragment,
    });
  }
  return entries;
}

async function loadFonts(pdf) {
  const regular = pdf.registerFont(
    parseTrueTypeFont(await readFile(path.join(FONT_ROOT, "IBMPlexMono-Regular.ttf"))),
    "IBMPlexMono-Regular",
  );
  const bold = pdf.registerFont(
    parseTrueTypeFont(await readFile(path.join(FONT_ROOT, "IBMPlexMono-Bold.ttf"))),
    "IBMPlexMono-Bold",
  );
  return { regular, bold };
}

function pageRuns({ page, pageNumber, totalPages, headerLeft, footer, regular, bold }) {
  const columnWidth = (GEOMETRY.bodySize * 600) / 1000;
  const rightEdge = GEOMETRY.left + columnWidth * DEFAULT_LAYOUT.columns;
  const headerRight = `Лист ${pageNumber} из ${totalPages}`;
  const runs = [
    {
      usage: bold,
      size: GEOMETRY.headerSize,
      x: GEOMETRY.left,
      y: GEOMETRY.headerBaseline,
      text: headerLeft,
    },
    {
      usage: bold,
      size: GEOMETRY.headerSize,
      x: rightEdge - bold.measure(headerRight) * GEOMETRY.headerSize,
      y: GEOMETRY.headerBaseline,
      text: headerRight,
    },
  ];
  page.lines.forEach((line, lineIndex) => {
    if (line === "") return;
    runs.push({
      usage: regular,
      size: GEOMETRY.bodySize,
      x: GEOMETRY.left,
      y: GEOMETRY.firstBaseline - lineIndex * GEOMETRY.bodyLeading,
      text: line,
    });
  });
  runs.push({
    usage: regular,
    size: GEOMETRY.headerSize,
    x: GEOMETRY.left,
    y: GEOMETRY.footerBaseline,
    text: footer,
  });
  return {
    runs,
    lines: [
      { x1: GEOMETRY.left, y1: GEOMETRY.ruleY, x2: rightEdge, y2: GEOMETRY.ruleY, width: 0.6 },
    ],
  };
}

export function renderPdf({ pdf, document, meta, regular, bold }) {
  const headerLeft = `${meta.title} — депонируемые материалы (исходный текст)`;
  document.pages.forEach((page, pageIndex) => {
    const footer = page.file ? `Файл: ${page.file}` : `${meta.holder}. ${meta.sourceState}`;
    pdf.addPage(
      pageRuns({
        page,
        pageNumber: pageIndex + 1,
        totalPages: document.totalPages,
        headerLeft,
        footer,
        regular,
        bold,
      }),
    );
  });
}

async function buildAbstractPdf({ root, manifest, meta, creationDate, outDir }) {
  const abstractPath = path.resolve(root, manifest.abstract ?? DEFAULT_ABSTRACT);
  const text = extractAbstract(await readFile(abstractPath, "utf8"), ABSTRACT_EDITION);
  const lines = buildAbstractPage(meta, text, ABSTRACT_COLUMNS);
  if (lines.length > DEFAULT_LAYOUT.linesPerPage) {
    throw new Error("abstract does not fit on one page; shorten the main edition");
  }
  const pdf = new PdfDocument({
    title: `${manifest.title} — реферат программы для ЭВМ`,
    author: manifest.holder,
    subject: `Реферат программы для ЭВМ «${manifest.title}», версия ${manifest.version}`,
    creator: "Markiro tools/rospatent/build-deposit.mjs",
    creationDate,
  });
  const { regular, bold } = await loadFonts(pdf);
  pdf.addPage(
    pageRuns({
      page: { lines },
      pageNumber: 1,
      totalPages: 1,
      headerLeft: `${meta.title} — реферат`,
      footer: `${meta.holder}. ${meta.sourceState}`,
      regular,
      bold,
    }),
  );
  const bytes = pdf.render();
  const pdfPath = path.join(outDir, "abstract.pdf");
  await writeFile(pdfPath, bytes);
  return {
    pdfPath,
    summary: {
      path: path.relative(root, pdfPath),
      source: path.relative(root, abstractPath),
      edition: ABSTRACT_EDITION,
      characters: Array.from(text).length,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

export async function buildDeposit(options) {
  const root = REPOSITORY_ROOT;
  const manifestPath = path.resolve(root, options.manifest);
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const creationDate = options.date ? new Date(options.date) : new Date();
  const sourceState = describeSourceState(root);
  const meta = {
    title: manifest.title,
    holder: manifest.holder,
    authors: manifest.authors,
    version: manifest.version,
    languages: manifest.languages,
    sourceState: sourceState.label,
    year: creationDate.getUTCFullYear(),
  };
  const entries = await loadEntries(manifest, root);
  const document = layoutDocument(meta, entries);
  if (document.totalPages > manifest.maxPages) {
    throw new Error(
      `deposit listing is ${document.totalPages} pages, above manifest.maxPages=${manifest.maxPages}; ` +
        "narrow the line ranges in the manifest",
    );
  }

  const pdf = new PdfDocument({
    title: `${manifest.title} — депонируемые материалы, идентифицирующие программу для ЭВМ`,
    author: manifest.holder,
    subject: `Фрагменты исходного текста программы для ЭВМ «${manifest.title}», версия ${manifest.version}`,
    creator: "Markiro tools/rospatent/build-deposit.mjs",
    creationDate,
  });
  const { regular, bold } = await loadFonts(pdf);
  renderPdf({ pdf, document, meta, regular, bold });
  const bytes = pdf.render();

  const outDir = path.resolve(root, options.out);
  await mkdir(outDir, { recursive: true });
  const pdfPath = path.join(outDir, "deposit.pdf");
  await writeFile(pdfPath, bytes);
  const abstract = await buildAbstractPdf({ root, manifest, meta, creationDate, outDir });
  const summary = {
    title: manifest.title,
    version: manifest.version,
    holder: manifest.holder,
    authors: manifest.authors,
    generatedAt: creationDate.toISOString(),
    source: sourceState,
    pages: document.totalPages,
    sourceLines: document.sourceLines,
    pdf: {
      path: path.relative(root, pdfPath),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    abstract: abstract.summary,
    files: entries.map((entry, index) => ({
      path: entry.path,
      lines: [entry.from, entry.to],
      totalLines: entry.total,
      sha256: entry.sha256,
      firstPage: document.bodyStartPage + document.starts[index] - 1,
    })),
  };
  const summaryPath = path.join(outDir, "deposit-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, pdfPath, abstractPath: abstract.pdfPath, summaryPath };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const { summary, pdfPath, abstractPath, summaryPath } = await buildDeposit(
      parseArguments(process.argv.slice(2)),
    );
    console.log(
      `Deposit listing: ${summary.pages} pages, ${summary.files.length} files, ${summary.sourceLines} source lines`,
    );
    console.log(`PDF: ${pdfPath} (${summary.pdf.bytes} bytes, sha256 ${summary.pdf.sha256})`);
    console.log(
      `Abstract: ${abstractPath} (${summary.abstract.characters} characters, sha256 ${summary.abstract.sha256})`,
    );
    console.log(`Summary: ${summaryPath}`);
  } catch (error) {
    console.error(`build-deposit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
