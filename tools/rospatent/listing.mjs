// Pure layout for the Rospatent deposit listing: turns selected source files
// into fixed-width pages (title page, table of contents, numbered listing).
// No I/O here so the pagination rules are unit-testable.

export const DEFAULT_LAYOUT = Object.freeze({
  columns: 94,
  linesPerPage: 66,
  gutter: 7, // "12345 │" — line number plus separator
  minimumLinesForFileHeader: 8,
});

const TAB_WIDTH = 4;

export function normalizeSourceLine(line) {
  return line.replace(/\r$/u, "").replace(/\t/gu, " ".repeat(TAB_WIDTH));
}

/** Wraps a path at "/" boundaries so contents entries stay readable. */
export function wrapPath(text, width) {
  const chunks = [];
  let rest = text;
  while (Array.from(rest).length > width) {
    const head = Array.from(rest).slice(0, width).join("");
    const cut = head.lastIndexOf("/");
    if (cut <= 0) break;
    chunks.push(head.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  return [...chunks, ...wrapLine(rest, width)];
}

/** Splits `text` into chunks of at most `width` characters (code points). */
export function wrapLine(text, width) {
  if (width < 1) throw new Error("wrap width must be positive");
  const characters = Array.from(text);
  if (characters.length <= width) return [text];
  const chunks = [];
  for (let index = 0; index < characters.length; index += width) {
    chunks.push(characters.slice(index, index + width).join(""));
  }
  return chunks;
}

/**
 * Selects the deposited fragment of one file.
 * `lines` is an inclusive 1-based range; `maxLines` caps from the first line.
 */
export function selectFragment(source, { lines, maxLines } = {}) {
  const all = source.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const total = all.length;
  let from = 1;
  let to = total;
  if (lines) {
    if (!Array.isArray(lines) || lines.length !== 2) throw new Error("lines must be [from, to]");
    [from, to] = lines;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new Error(`invalid line range ${JSON.stringify(lines)}`);
    }
    to = Math.min(to, total);
    if (from > total) throw new Error(`line range starts after the end of the file (${total})`);
  }
  if (maxLines !== undefined) {
    if (!Number.isInteger(maxLines) || maxLines < 1) throw new Error("maxLines must be positive");
    to = Math.min(to, from + maxLines - 1);
  }
  return { from, to, total, lines: all.slice(from - 1, to).map(normalizeSourceLine) };
}

function fileHeaderLines(entry, columns) {
  const rule = "═".repeat(columns);
  const scope =
    entry.from === 1 && entry.to === entry.total
      ? `полный текст, строк: ${entry.total}`
      : `фрагмент: строки ${entry.from}–${entry.to} из ${entry.total}`;
  const lines = [rule, `Файл: ${entry.path}`, `Объём: ${scope}`];
  if (entry.comment) lines.push(`Назначение: ${entry.comment}`);
  lines.push(rule);
  return lines.flatMap((line) => wrapLine(line, columns));
}

function numberedLines(entry, layout) {
  const width = layout.columns - layout.gutter - 1;
  const result = [];
  entry.lines.forEach((text, index) => {
    const number = String(entry.from + index).padStart(layout.gutter - 2, " ");
    const chunks = wrapLine(text, width);
    chunks.forEach((chunk, chunkIndex) => {
      const gutter = chunkIndex === 0 ? `${number} │ ` : `${" ".repeat(layout.gutter - 2)} ┆ `;
      result.push(`${gutter}${chunk}`);
    });
  });
  return result;
}

/**
 * Lays out the listing body. Returns pages of plain strings plus the page
 * index at which each file starts (1-based, relative to the body).
 */
export function paginateListing(entries, layout = DEFAULT_LAYOUT) {
  const pages = [];
  let current = [];
  let currentFile = null;
  const starts = [];
  const flush = () => {
    if (current.length > 0) pages.push({ file: currentFile, lines: current });
    current = [];
  };
  entries.forEach((entry, entryIndex) => {
    const header = fileHeaderLines(entry, layout.columns);
    const remaining = layout.linesPerPage - current.length;
    if (entryIndex > 0 && current.length > 0) {
      if (remaining < layout.minimumLinesForFileHeader + header.length) flush();
      else current.push("", "");
    }
    currentFile = entry.path;
    starts.push(pages.length + 1);
    for (const line of [...header, ...numberedLines(entry, layout)]) {
      if (current.length >= layout.linesPerPage) {
        flush();
        currentFile = entry.path;
      }
      current.push(line);
    }
  });
  flush();
  return { pages, starts };
}

function padRight(text, width) {
  const length = Array.from(text).length;
  return length >= width ? text : text + " ".repeat(width - length);
}

export function buildTitlePage(meta, stats, columns) {
  const center = (text) => {
    const pad = Math.max(0, Math.floor((columns - Array.from(text).length) / 2));
    return " ".repeat(pad) + text;
  };
  const authors = meta.authors.join(", ");
  return [
    "",
    "",
    "",
    center("ДЕПОНИРУЕМЫЕ МАТЕРИАЛЫ,"),
    center("ИДЕНТИФИЦИРУЮЩИЕ ПРОГРАММУ ДЛЯ ЭВМ"),
    "",
    "",
    center(meta.title),
    "",
    "",
    "",
    `Название программы для ЭВМ: ${meta.title}`,
    "",
    `Правообладатель: ${meta.holder}`,
    "",
    `Автор${meta.authors.length > 1 ? "ы" : ""}: ${authors}`,
    "",
    `Версия программы: ${meta.version}`,
    "",
    `Состояние исходного текста: ${meta.sourceState}`,
    "",
    "Вид депонируемых материалов: фрагменты исходного текста программы",
    "",
    `Языки программирования: ${meta.languages.join(", ")}`,
    "",
    `Объём листинга: файлов ${stats.files}, строк исходного текста ${stats.sourceLines}, ` +
      `листов ${stats.totalPages}`,
    "",
    "Оглавление приведено на следующем листе.",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    center(`${meta.holder}, ${meta.year}`),
  ].flatMap((line) => wrapLine(line, columns));
}

export function buildContentsLines(entries, starts, bodyStartPage, columns) {
  const lines = [
    "ОГЛАВЛЕНИЕ",
    "",
    padRight("№", 4) + padRight("Файл", columns - 4 - 24) + padRight("Строки", 18) + "Лист",
    "",
  ];
  entries.forEach((entry, index) => {
    const page = String(bodyStartPage + starts[index] - 1);
    const range =
      entry.from === 1 && entry.to === entry.total
        ? `1–${entry.total}`
        : `${entry.from}–${entry.to} из ${entry.total}`;
    const fileWidth = columns - 4 - 24;
    const pathChunks = wrapPath(entry.path, fileWidth);
    pathChunks.forEach((chunk, chunkIndex) => {
      const last = chunkIndex === pathChunks.length - 1;
      lines.push(
        padRight(chunkIndex === 0 ? String(index + 1) : "", 4) +
          padRight(chunk, fileWidth) +
          (last ? padRight(range, 18) + page : ""),
      );
    });
  });
  return lines;
}

/**
 * Full document layout: title page, contents pages, then the listing body.
 * Every page carries the file it shows (or null) for the running header.
 */
export function layoutDocument(meta, entries, layout = DEFAULT_LAYOUT) {
  const body = paginateListing(entries, layout);
  const sourceLines = entries.reduce((sum, entry) => sum + entry.lines.length, 0);
  // Contents length depends on entries only, so compute it before the body offset.
  const contentsLines = buildContentsLines(entries, body.starts, 0, layout.columns);
  const contentsPages = Math.max(1, Math.ceil(contentsLines.length / layout.linesPerPage));
  const bodyStartPage = 1 + contentsPages + 1;
  const totalPages = 1 + contentsPages + body.pages.length;
  const title = buildTitlePage(
    meta,
    { files: entries.length, sourceLines, totalPages },
    layout.columns,
  );
  if (title.length > layout.linesPerPage) throw new Error("title page does not fit on one page");
  const pages = [{ kind: "title", file: null, lines: title }];
  const finalContents = buildContentsLines(entries, body.starts, bodyStartPage, layout.columns);
  for (let index = 0; index < contentsPages; index += 1) {
    pages.push({
      kind: "contents",
      file: null,
      lines: finalContents.slice(index * layout.linesPerPage, (index + 1) * layout.linesPerPage),
    });
  }
  for (const page of body.pages)
    pages.push({ kind: "listing", file: page.file, lines: page.lines });
  if (pages.length !== totalPages) throw new Error("page accounting drifted");
  return { pages, totalPages, sourceLines, bodyStartPage, starts: body.starts };
}

/** Word-wraps prose to `width` columns; words longer than the width are hard-split. */
export function wrapWords(text, width) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (Array.from(candidate).length <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    const chunks = wrapLine(word, width);
    lines.push(...chunks.slice(0, -1));
    current = chunks.at(-1) ?? "";
  }
  if (current !== "") lines.push(current);
  return lines;
}

/**
 * Pulls one edition of the abstract out of abstract.md: the prose under the
 * `## <heading>` section, joined into a single paragraph.
 */
export function extractAbstract(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`abstract.md has no section "## ${heading}"`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /u.test(line)) break;
    body.push(line);
  }
  const text = body.join(" ").replace(/\s+/gu, " ").trim();
  if (text === "") throw new Error(`abstract section "${heading}" is empty`);
  return text;
}

export function buildAbstractPage(meta, abstractText, columns) {
  const center = (text) => {
    const pad = Math.max(0, Math.floor((columns - Array.from(text).length) / 2));
    return " ".repeat(pad) + text;
  };
  const authors = meta.authors.join(", ");
  return [
    "",
    "",
    center("РЕФЕРАТ"),
    center("программы для ЭВМ"),
    "",
    "",
    `Название программы для ЭВМ: ${meta.title}`,
    `Правообладатель: ${meta.holder}`,
    `Автор${meta.authors.length > 1 ? "ы" : ""}: ${authors}`,
    `Версия программы: ${meta.version}`,
    `Год создания: ${meta.year}`,
    "",
    "",
    ...wrapWords(abstractText, columns),
    "",
    "",
    `Объём реферата: ${Array.from(abstractText).length} знаков.`,
    "",
    "",
    "",
    center(`${meta.holder}, ${meta.year}`),
  ].flatMap((line) => wrapLine(line, columns));
}
